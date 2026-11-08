import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
	CaptureCheckpointOptions,
	CheckpointInfo,
	CheckpointResult,
	GitCheckpointOptions,
	ListCheckpointsOptions,
	PruneCheckpointsOptions,
	PruneCheckpointsResult,
} from "./types";

const execAsync = promisify(execFile);

/**
 * Validates that an identifier does not contain disallowed git ref characters.
 */
export function validateId(id: string, fieldName = "id"): void {
	if (!id || typeof id !== "string" || id.trim().length === 0) {
		throw new Error(`${fieldName} cannot be empty`);
	}
	// Git ref component rules: no '/', '\\', '..', '@{', control chars, spaces, ~, ^, :, ?, *, [
	if (
		id.includes("/") ||
		id.includes("\\") ||
		id.includes("..") ||
		id.includes("@{") ||
		/[\s~^:?*[\x00-\x1f\x7f]/.test(id) ||
		id.startsWith(".") ||
		id.endsWith(".") ||
		id.endsWith(".lock")
	) {
		throw new Error(`Invalid characters in ${fieldName}: "${id}"`);
	}
}

/**
 * Returns the hidden git ref for an Aery checkpoint.
 */
export function getCheckpointRef(sessionId: string, entryId: string): string {
	validateId(sessionId, "sessionId");
	validateId(entryId, "entryId");
	return `refs/aery/checkpoints/${sessionId}/${entryId}`;
}

/**
 * Checks if the given path is inside a git repository working tree.
 */
export async function isGitRepository(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

/**
 * Resolves the top-level repository root directory.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
	const { stdout } = await execAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
	return stdout.trim();
}

/**
 * Captures a checkpoint of the working tree using an isolated temporary git index.
 * Hidden ref is created at refs/aery/checkpoints/<sessionId>/<entryId>.
 * HEAD commit log and baseline count are not altered.
 */
export async function captureCheckpoint(options: CaptureCheckpointOptions): Promise<CheckpointResult> {
	const { cwd, sessionId, entryId, message } = options;

	const isRepo = await isGitRepository(cwd);
	if (!isRepo) {
		throw new Error(`Not a git repository: ${cwd}`);
	}

	const repoRoot = await getRepoRoot(cwd);
	const ref = getCheckpointRef(sessionId, entryId);
	const tempIndex = path.join(os.tmpdir(), `aery-cp-idx-${randomUUID()}`);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_INDEX_FILE: tempIndex,
		GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Aery Checkpoint",
		GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "checkpoint@aery.local",
		GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Aery Checkpoint",
		GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "checkpoint@aery.local",
	};

	try {
		// Determine whether HEAD exists
		let headCommit: string | null = null;
		try {
			const { stdout } = await execAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, env });
			headCommit = stdout.trim() || null;
		} catch {
			// Repository has no commits yet
		}

		if (headCommit) {
			await execAsync("git", ["read-tree", "HEAD"], { cwd: repoRoot, env });
		}

		// Stage all changes into isolated temporary index from repository root
		await execAsync("git", ["add", "-A"], { cwd: repoRoot, env });

		// Write tree from isolated index
		const { stdout: treeOut } = await execAsync("git", ["write-tree"], { cwd: repoRoot, env });
		const treeSha = treeOut.trim();

		// Create commit object
		const commitMessage = message ?? `aery checkpoint ${sessionId}/${entryId}`;
		const commitArgs = ["commit-tree", treeSha, "-m", commitMessage];
		if (headCommit) {
			commitArgs.push("-p", headCommit);
		}

		const { stdout: commitOut } = await execAsync("git", commitArgs, { cwd: repoRoot, env });
		const commitSha = commitOut.trim();

		// Update hidden ref
		await execAsync("git", ["update-ref", ref, commitSha], { cwd: repoRoot });

		return {
			ref,
			commit: commitSha,
			tree: treeSha,
		};
	} finally {
		try {
			await fs.rm(tempIndex, { force: true });
		} catch {
			// Ignore temporary file cleanup errors
		}
	}
}

/**
 * Checks whether a checkpoint ref exists.
 */
export async function hasCheckpoint(options: GitCheckpointOptions): Promise<boolean> {
	try {
		const ref = getCheckpointRef(options.sessionId, options.entryId);
		await execAsync("git", ["rev-parse", "--verify", ref], { cwd: options.cwd });
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves the commit SHA for a checkpoint ref, or null if it does not exist.
 */
export async function resolveCheckpointCommit(options: GitCheckpointOptions): Promise<string | null> {
	try {
		const ref = getCheckpointRef(options.sessionId, options.entryId);
		const { stdout } = await execAsync("git", ["rev-parse", "--verify", ref], { cwd: options.cwd });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Restores modified files from a checkpoint and cleans untracked files across the repository.
 */
export async function restoreCheckpoint(options: GitCheckpointOptions): Promise<void> {
	const isRepo = await isGitRepository(options.cwd);
	if (!isRepo) {
		throw new Error(`Not a git repository: ${options.cwd}`);
	}

	const repoRoot = await getRepoRoot(options.cwd);
	const commitSha = await resolveCheckpointCommit(options);
	if (!commitSha) {
		const ref = getCheckpointRef(options.sessionId, options.entryId);
		throw new Error(`Checkpoint ref not found: ${ref}`);
	}

	// Reset index to checkpoint tree using repository root
	await execAsync("git", ["read-tree", commitSha], { cwd: repoRoot });

	// Force checkout tracked files into working tree
	await execAsync("git", ["checkout-index", "-a", "-f"], { cwd: repoRoot });

	// Clean untracked files and directories across the repository
	await execAsync("git", ["clean", "-fd"], { cwd: repoRoot });
}

/**
 * Prunes checkpoints older than maxAgeDays.
 */
export async function pruneCheckpoints(options: PruneCheckpointsOptions): Promise<PruneCheckpointsResult> {
	const { cwd, maxAgeDays } = options;
	const cutoffSeconds = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;

	const deletedRefs: string[] = [];

	try {
		const { stdout } = await execAsync(
			"git",
			["for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/aery/checkpoints"],
			{ cwd },
		);

		const lines = stdout.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [ref, timestampStr] = line.trim().split(/\s+/);
			const timestamp = parseInt(timestampStr, 10);
			if (ref && !isNaN(timestamp) && timestamp <= cutoffSeconds) {
				await execAsync("git", ["update-ref", "-d", ref], { cwd });
				deletedRefs.push(ref);
			}
		}
	} catch {
		// No checkpoints found or git command failed
	}

	return {
		deletedRefs,
		deletedCount: deletedRefs.length,
	};
}

/**
 * Lists checkpoints in a repository, optionally filtered by sessionId.
 */
export async function listCheckpoints(options: ListCheckpointsOptions): Promise<CheckpointInfo[]> {
	if (options.sessionId) {
		validateId(options.sessionId, "sessionId");
	}

	const prefix = options.sessionId ? `refs/aery/checkpoints/${options.sessionId}` : "refs/aery/checkpoints";

	try {
		const { stdout } = await execAsync(
			"git",
			["for-each-ref", "--format=%(refname) %(objectname) %(committerdate:unix)", prefix],
			{ cwd: options.cwd },
		);

		const results: CheckpointInfo[] = [];
		const lines = stdout.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [ref, commit, tsStr] = line.trim().split(/\s+/);
			if (!ref || !commit) continue;
			const trimmedRef = ref.replace(/^refs\/aery\/checkpoints\//, "");
			const slashIdx = trimmedRef.indexOf("/");
			const sessionId = slashIdx !== -1 ? trimmedRef.slice(0, slashIdx) : trimmedRef;
			const entryId = slashIdx !== -1 ? trimmedRef.slice(slashIdx + 1) : "";
			const timestampSeconds = parseInt(tsStr, 10);
			const timestampMs = isNaN(timestampSeconds) ? 0 : timestampSeconds * 1000;
			results.push({
				ref,
				sessionId,
				entryId,
				commit,
				timestamp: timestampMs,
			});
		}

		return results;
	} catch {
		return [];
	}
}

/**
 * Deletes a single checkpoint ref.
 */
export async function deleteCheckpoint(options: GitCheckpointOptions): Promise<boolean> {
	try {
		const ref = getCheckpointRef(options.sessionId, options.entryId);
		await execAsync("git", ["update-ref", "-d", ref], { cwd: options.cwd });
		return true;
	} catch {
		return false;
	}
}

/**
 * GitCheckpointService class providing static and instance access to git checkpoint operations.
 */
export class GitCheckpointService {
	constructor(private readonly defaultCwd?: string) {}

	static isGitRepository = isGitRepository;
	static getRepoRoot = getRepoRoot;
	static validateId = validateId;
	static captureCheckpoint = captureCheckpoint;
	static hasCheckpoint = hasCheckpoint;
	static resolveCheckpointCommit = resolveCheckpointCommit;
	static restoreCheckpoint = restoreCheckpoint;
	static pruneCheckpoints = pruneCheckpoints;
	static listCheckpoints = listCheckpoints;
	static deleteCheckpoint = deleteCheckpoint;
	static getCheckpointRef = getCheckpointRef;

	private getCwd(overrideCwd?: string): string {
		return overrideCwd ?? this.defaultCwd ?? process.cwd();
	}

	async isGitRepository(cwd?: string): Promise<boolean> {
		return isGitRepository(this.getCwd(cwd));
	}

	async getRepoRoot(cwd?: string): Promise<string> {
		return getRepoRoot(this.getCwd(cwd));
	}

	async captureCheckpoint(
		options: Omit<CaptureCheckpointOptions, "cwd"> & { cwd?: string },
	): Promise<CheckpointResult> {
		return captureCheckpoint({
			...options,
			cwd: this.getCwd(options.cwd),
		});
	}

	async hasCheckpoint(options: Omit<GitCheckpointOptions, "cwd"> & { cwd?: string }): Promise<boolean> {
		return hasCheckpoint({
			...options,
			cwd: this.getCwd(options.cwd),
		});
	}

	async resolveCheckpointCommit(
		options: Omit<GitCheckpointOptions, "cwd"> & { cwd?: string },
	): Promise<string | null> {
		return resolveCheckpointCommit({
			...options,
			cwd: this.getCwd(options.cwd),
		});
	}

	async restoreCheckpoint(options: Omit<GitCheckpointOptions, "cwd"> & { cwd?: string }): Promise<void> {
		return restoreCheckpoint({
			...options,
			cwd: this.getCwd(options.cwd),
		});
	}

	async pruneCheckpoints(options?: { cwd?: string; maxAgeDays?: number }): Promise<PruneCheckpointsResult> {
		return pruneCheckpoints({
			cwd: this.getCwd(options?.cwd),
			maxAgeDays: options?.maxAgeDays ?? 30,
		});
	}

	async listCheckpoints(options?: { cwd?: string; sessionId?: string }): Promise<CheckpointInfo[]> {
		return listCheckpoints({
			cwd: this.getCwd(options?.cwd),
			sessionId: options?.sessionId,
		});
	}

	async deleteCheckpoint(options: Omit<GitCheckpointOptions, "cwd"> & { cwd?: string }): Promise<boolean> {
		return deleteCheckpoint({
			...options,
			cwd: this.getCwd(options.cwd),
		});
	}
}
