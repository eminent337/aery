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
 * Returns the hidden git ref for an Aery checkpoint.
 */
export function getCheckpointRef(sessionId: string, entryId: string): string {
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
			const { stdout } = await execAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd, env });
			headCommit = stdout.trim() || null;
		} catch {
			// Repository has no commits yet
		}

		if (headCommit) {
			await execAsync("git", ["read-tree", "HEAD"], { cwd, env });
		}

		// Stage all changes into isolated temporary index
		await execAsync("git", ["add", "-A"], { cwd, env });

		// Write tree from isolated index
		const { stdout: treeOut } = await execAsync("git", ["write-tree"], { cwd, env });
		const treeSha = treeOut.trim();

		// Create commit object
		const commitMessage = message ?? `aery checkpoint ${sessionId}/${entryId}`;
		const commitArgs = ["commit-tree", treeSha, "-m", commitMessage];
		if (headCommit) {
			commitArgs.push("-p", headCommit);
		}

		const { stdout: commitOut } = await execAsync("git", commitArgs, { cwd, env });
		const commitSha = commitOut.trim();

		// Update hidden ref
		await execAsync("git", ["update-ref", ref, commitSha], { cwd });

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
	const ref = getCheckpointRef(options.sessionId, options.entryId);
	try {
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
	const ref = getCheckpointRef(options.sessionId, options.entryId);
	try {
		const { stdout } = await execAsync("git", ["rev-parse", "--verify", ref], { cwd: options.cwd });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Restores modified files from a checkpoint and cleans untracked files.
 */
export async function restoreCheckpoint(options: GitCheckpointOptions): Promise<void> {
	const commitSha = await resolveCheckpointCommit(options);
	if (!commitSha) {
		const ref = getCheckpointRef(options.sessionId, options.entryId);
		throw new Error(`Checkpoint ref not found: ${ref}`);
	}

	// Reset index to checkpoint tree
	await execAsync("git", ["read-tree", commitSha], { cwd: options.cwd });

	// Force checkout tracked files into working tree
	await execAsync("git", ["checkout-index", "-a", "-f"], { cwd: options.cwd });

	// Clean untracked files and directories
	await execAsync("git", ["clean", "-fd"], { cwd: options.cwd });
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
			const [ref, timestampStr] = line.trim().split(" ");
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
			const [ref, commit, tsStr] = line.trim().split(" ");
			if (!ref || !commit) continue;
			const trimmedRef = ref.replace(/^refs\/aery\/checkpoints\//, "");
			const slashIdx = trimmedRef.indexOf("/");
			const sessionId = slashIdx !== -1 ? trimmedRef.slice(0, slashIdx) : trimmedRef;
			const entryId = slashIdx !== -1 ? trimmedRef.slice(slashIdx + 1) : "";
			const timestamp = parseInt(tsStr, 10);
			results.push({
				ref,
				sessionId,
				entryId,
				commit,
				timestamp: isNaN(timestamp) ? 0 : timestamp,
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
	const ref = getCheckpointRef(options.sessionId, options.entryId);
	try {
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
