/**
 * Battle Worktree Allocator.
 *
 * Manages allocation, git branch lifecycle, diff calculation, and teardown
 * for ephemeral candidate worktrees during Battle Mode execution.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DiffFileChange, DiffSummary } from "./types";

const execAsync = promisify(execFile);

export interface AllocatedWorktree {
	worktreePath: string;
	branchName: string;
}

function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getBattleBaseDir(): string {
	return path.join(os.homedir(), ".aery", "wt", "battles");
}

/**
 * Creates an isolated git worktree for a battle candidate.
 */
export async function allocateBattleWorktree(
	repoRoot: string,
	battleId: string,
	candidateId: string,
): Promise<AllocatedWorktree> {
	const safeBattleId = sanitizeId(battleId);
	const safeCandidateId = sanitizeId(candidateId);
	const branchName = `battle/${safeBattleId}/${safeCandidateId}`;
	const baseDir = getBattleBaseDir();
	await fs.mkdir(baseDir, { recursive: true });

	const worktreePath = path.join(baseDir, `${safeBattleId}-${safeCandidateId}`);

	// Clean any previous stray with same path
	try {
		await fs.rm(worktreePath, { recursive: true, force: true });
	} catch {}

	// Add worktree and branch from current HEAD
	try {
		await execAsync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
			cwd: repoRoot,
		});
	} catch {
		// If branch already exists, delete and re-try
		try {
			await execAsync("git", ["branch", "-D", branchName], { cwd: repoRoot });
			await execAsync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
				cwd: repoRoot,
			});
		} catch (retryErr) {
			throw new Error(`Failed to allocate battle worktree at ${worktreePath}: ${String(retryErr)}`);
		}
	}

	return { worktreePath, branchName };
}

/**
 * Calculates git diff and changed files between base branch/commit and the candidate worktree HEAD.
 */
export async function getBattleDiff(worktreePath: string, baseRef = "HEAD"): Promise<DiffSummary> {
	try {
		// Get unified diff patch
		const { stdout: patch } = await execAsync("git", ["diff", baseRef, "HEAD"], {
			cwd: worktreePath,
		});

		// Get numstat for exact file churn
		const { stdout: numstat } = await execAsync("git", ["diff", "--numstat", baseRef, "HEAD"], {
			cwd: worktreePath,
		});

		const files: DiffFileChange[] = [];
		let totalAdditions = 0;
		let totalDeletions = 0;

		const lines = numstat.split("\n").filter(Boolean);
		for (const line of lines) {
			const parts = line.split("\t");
			if (parts.length >= 3) {
				const adds = Number.parseInt(parts[0], 10) || 0;
				const dels = Number.parseInt(parts[1], 10) || 0;
				const filePath = parts.slice(2).join("\t").trim();

				totalAdditions += adds;
				totalDeletions += dels;

				files.push({
					path: filePath,
					status: dels > 0 && adds === 0 ? "deleted" : adds > 0 && dels === 0 ? "added" : "modified",
					additions: adds,
					deletions: dels,
				});
			}
		}

		return {
			files,
			patch,
			totalAdditions,
			totalDeletions,
		};
	} catch {
		return {
			files: [],
			patch: "",
			totalAdditions: 0,
			totalDeletions: 0,
		};
	}
}

/**
 * Removes the ephemeral worktree and optionally deletes the candidate branch.
 */
export async function cleanupBattleWorktree(
	repoRoot: string,
	worktreePath: string,
	branchName: string,
	deleteBranch = true,
): Promise<void> {
	try {
		await execAsync("git", ["worktree", "remove", "--force", worktreePath], {
			cwd: repoRoot,
		});
	} catch {
		// Fallback manual directory cleanup
		try {
			await fs.rm(worktreePath, { recursive: true, force: true });
			await execAsync("git", ["worktree", "prune"], { cwd: repoRoot });
		} catch {}
	}

	if (deleteBranch) {
		try {
			await execAsync("git", ["branch", "-D", branchName], { cwd: repoRoot });
		} catch {}
	}
}
