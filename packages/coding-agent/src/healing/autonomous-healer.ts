/**
 * Autonomous Self-Healing Engine.
 *
 * Automatically intercepts failed builds/test suites, spawns an ephemeral
 * worktree, applies targeted repairs, verifies the fix, and presents or applies
 * the minimal clean diff.
 */

import { allocateBattleWorktree, cleanupBattleWorktree, getBattleDiff } from "../battle/worktree-allocator";
import { executeBash } from "../exec/bash-executor";
import { patch } from "../utils/git";
import type { HealerOptions, HealingResult } from "./types";

export type RepairStrategyFn = (errorOutput: string, worktreePath: string) => Promise<boolean>;

export class AutonomousHealer {
	private repoRoot: string;

	constructor(baseRepoPath?: string) {
		this.repoRoot = baseRepoPath ?? process.cwd();
	}

	/**
	 * Executes a build or test command; if it fails, orchestrates isolated self-healing.
	 */
	public async heal(
		command: string,
		repairStrategy?: RepairStrategyFn,
		options?: HealerOptions,
	): Promise<HealingResult> {
		const cwd = options?.cwd ?? this.repoRoot;
		const maxAttempts = options?.maxAttempts ?? 3;
		const autoApply = options?.autoApply ?? false;

		// 1. Initial test run
		const initialRun = await executeBash(command, { cwd, skipHooks: true, skipPolicyGuardian: true });
		if (initialRun.exitCode === 0) {
			return {
				success: true,
				attempts: 0,
				command,
				initialError: "",
				applied: false,
				summary: "Command already succeeds; no healing required.",
			};
		}

		const initialError = initialRun.output;

		// Get current HEAD commit of base repo to diff against
		const headRun = await executeBash("git rev-parse HEAD", { cwd, skipHooks: true, skipPolicyGuardian: true });
		const baseCommit = headRun.output.trim() || "HEAD";

		// 2. Allocate ephemeral worktree for safe, isolated healing
		const healId = `heal-${Date.now()}`;
		const { worktreePath, branchName } = await allocateBattleWorktree(cwd, healId, "candidate");

		try {
			let currentError = initialError;
			let attempts = 0;
			let healed = false;

			while (attempts < maxAttempts && !healed) {
				attempts++;

				// Execute repair strategy
				if (repairStrategy) {
					const patchApplied = await repairStrategy(currentError, worktreePath);
					if (!patchApplied) {
						break;
					}
				}

				// Re-verify command inside worktree
				const verifyRun = await executeBash(command, {
					cwd: worktreePath,
					skipHooks: true,
					skipPolicyGuardian: true,
				});

				if (verifyRun.exitCode === 0) {
					healed = true;
					break;
				}

				currentError = verifyRun.output;
			}

			if (!healed) {
				return {
					success: false,
					attempts,
					command,
					initialError,
					applied: false,
					summary: `Failed to heal command after ${attempts} attempt(s).`,
				};
			}

			// 3. Extract the clean patch diff from the worktree
			const diffSummary = await getBattleDiff(worktreePath, baseCommit);
			const diff = diffSummary.patch;

			// 4. If autoApply requested, apply diff back to main workspace
			let applied = false;
			if (autoApply && diff.trim().length > 0) {
				try {
					await patch.applyText(cwd, diff);
					applied = true;
				} catch {
					applied = false;
				}
			}

			return {
				success: true,
				attempts,
				command,
				initialError,
				repairedDiff: diff,
				applied,
				summary: `Successfully healed command '${command}' in ${attempts} attempt(s).`,
			};
		} finally {
			// Always clean up the ephemeral worktree
			await cleanupBattleWorktree(cwd, worktreePath, branchName, true);
		}
	}
}
