import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RepoChangeResult {
	changed: boolean;
	currentHash: string | null;
}

const GIT_SPAWN_TIMEOUT_MS = 5000;

async function runGitCommand(
	args: string[],
	cwd: string,
	timeoutMs = GIT_SPAWN_TIMEOUT_MS,
): Promise<{ stdout: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
			},
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<{ stdout: string; exitCode: number }>((_, reject) => {
			timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {}
				reject(new Error(`git command timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		const executionPromise = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
			([stdout, exitCode]) => ({ stdout, exitCode }),
		);

		const result = await Promise.race([executionPromise, timeoutPromise]);
		if (timer) clearTimeout(timer);
		return result;
	} catch {
		return { stdout: "", exitCode: 1 };
	}
}

/**
 * Computes a fast tree hash representing the working state of a git repository.
 * Returns null if the directory is not inside a git repository or git binary fails.
 * Returns a 40-character hex string (when clean) or a composite hash (when dirty)
 * representing the exact working tree state.
 */
export async function getGitTreeHash(cwd?: string): Promise<string | null> {
	const targetDir = cwd ? path.resolve(cwd) : process.cwd();

	try {
		if (!fs.existsSync(targetDir)) {
			return null;
		}

		// Run rev-parse and status check concurrently for optimal performance
		const [revResult, statusResult] = await Promise.all([
			runGitCommand(["rev-parse", "--show-toplevel", "HEAD^{tree}"], targetDir),
			runGitCommand(["-c", "core.quotepath=false", "status", "--porcelain=v1"], targetDir),
		]);

		let repoRoot = "";
		let treeOid = "";

		if (revResult.exitCode === 0) {
			const lines = revResult.stdout
				.trim()
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);
			if (lines.length >= 2) {
				repoRoot = lines[0];
				treeOid = lines[1];
			} else if (lines.length === 1) {
				repoRoot = lines[0];
			}
		}

		// If treeOid was not found (e.g. fresh repo with no commits yet)
		if (!treeOid) {
			const writeTreeResult = await runGitCommand(["write-tree", "--missing-ok"], targetDir);
			if (writeTreeResult.exitCode !== 0) {
				return null;
			}
			treeOid = writeTreeResult.stdout.trim();
		}

		// If still not a valid 40-character hex string
		if (!treeOid || treeOid.length !== 40) {
			return null;
		}

		// If status failed (not a git repo), return null
		if (statusResult.exitCode !== 0) {
			return null;
		}

		const statusTrimmed = statusResult.stdout.trim();
		if (!statusTrimmed) {
			// Working tree is completely clean
			return treeOid;
		}

		// If repoRoot was not captured from rev-parse, query it
		if (!repoRoot) {
			const rootResult = await runGitCommand(["rev-parse", "--show-toplevel"], targetDir);
			if (rootResult.exitCode === 0) {
				repoRoot = rootResult.stdout.trim();
			}
		}

		const effectiveRoot = repoRoot || targetDir;
		const dirtyItems: string[] = [];
		const statusLines = statusTrimmed.split("\n");

		for (const rawLine of statusLines) {
			const line = rawLine.trim();
			if (!line) continue;

			let filePath = line.slice(3).trim();
			if (filePath.includes(" -> ")) {
				filePath = filePath.split(" -> ")[1].trim();
			}
			filePath = filePath.replace(/^"(.*)"$/, "$1");

			try {
				const fullPath = path.resolve(effectiveRoot, filePath);
				const st = fs.statSync(fullPath);
				dirtyItems.push(`${line}:${st.mtimeMs}:${st.size}`);
			} catch {
				dirtyItems.push(line);
			}
		}

		const dirtyDigest = crypto.createHash("sha1").update(dirtyItems.join(";")).digest("hex").slice(0, 16);

		return `${treeOid}:${dirtyDigest}`;
	} catch {
		return null;
	}
}

/**
 * Checks whether the repository has changed since a previous hash.
 * Compares current tree hash against previousHash.
 */
export async function hasRepoChangedSince(cwd: string, previousHash: string | null): Promise<RepoChangeResult> {
	const currentHash = await getGitTreeHash(cwd);
	return {
		changed: currentHash !== previousHash,
		currentHash,
	};
}

/**
 * Uses `git diff --name-only <previousTreeOid>` to list modified files
 * since a previous tree hash without walking the entire disk.
 */
export async function getModifiedFilesSince(cwd: string, previousTreeOid: string): Promise<string[]> {
	if (!previousTreeOid || typeof previousTreeOid !== "string") {
		return [];
	}

	const targetDir = cwd ? path.resolve(cwd) : process.cwd();
	const treeIsh = previousTreeOid.includes(":") ? previousTreeOid.split(":")[0].trim() : previousTreeOid.trim();

	// Guard against flag injection or malformed object IDs
	if (!treeIsh || treeIsh.startsWith("-") || !/^[0-9a-fA-F]{4,40}$/.test(treeIsh)) {
		return [];
	}

	try {
		const diffResult = await runGitCommand(
			["-c", "core.quotepath=false", "diff", "--name-only", treeIsh, "--"],
			targetDir,
		);

		if (diffResult.exitCode !== 0) {
			return [];
		}

		const trimmed = diffResult.stdout.trim();
		if (!trimmed) {
			return [];
		}

		return trimmed
			.split("\n")
			.map(line => line.trim().replace(/^"(.*)"$/, "$1"))
			.filter(Boolean);
	} catch {
		return [];
	}
}
