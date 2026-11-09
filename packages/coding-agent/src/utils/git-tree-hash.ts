import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RepoChangeResult {
	changed: boolean;
	currentHash: string | null;
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
		const revParseProc = Bun.spawn(["git", "rev-parse", "--show-toplevel", "HEAD^{tree}"], {
			cwd: targetDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const statusProc = Bun.spawn(["git", "-c", "core.quotepath=false", "status", "--porcelain=v1"], {
			cwd: targetDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const [[revStdout, revExitCode], [statusStdout, statusExitCode]] = await Promise.all([
			Promise.all([new Response(revParseProc.stdout).text(), revParseProc.exited]),
			Promise.all([new Response(statusProc.stdout).text(), statusProc.exited]),
		]);

		let repoRoot = "";
		let treeOid = "";

		if (revExitCode === 0) {
			const lines = revStdout
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
			const writeTreeProc = Bun.spawn(["git", "write-tree", "--missing-ok"], {
				cwd: targetDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [writeTreeStdout, writeTreeExitCode] = await Promise.all([
				new Response(writeTreeProc.stdout).text(),
				writeTreeProc.exited,
			]);

			if (writeTreeExitCode !== 0) {
				return null;
			}
			treeOid = writeTreeStdout.trim();
		}

		// If still not a valid 40-character hex string
		if (!treeOid || treeOid.length !== 40) {
			return null;
		}

		// If status failed (not a git repo), return null
		if (statusExitCode !== 0) {
			return null;
		}

		const statusTrimmed = statusStdout.trim();
		if (!statusTrimmed) {
			// Working tree is completely clean
			return treeOid;
		}

		// If repoRoot was not captured from rev-parse, query it
		if (!repoRoot) {
			const rootProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
				cwd: targetDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [rootStdout, rootExitCode] = await Promise.all([new Response(rootProc.stdout).text(), rootProc.exited]);
			if (rootExitCode === 0) {
				repoRoot = rootStdout.trim();
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

	if (!treeIsh) {
		return [];
	}

	try {
		const proc = Bun.spawn(["git", "-c", "core.quotepath=false", "diff", "--name-only", treeIsh], {
			cwd: targetDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

		if (exitCode !== 0) {
			return [];
		}

		const trimmed = stdout.trim();
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
