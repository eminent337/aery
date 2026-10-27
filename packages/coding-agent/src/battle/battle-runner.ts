/**
 * Battle Runner Engine.
 *
 * Coordinates execution of parallel candidates in isolated worktrees, executes test suites,
 * collects diffs and metrics, and produces the final BattleVerdict.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { BattleConfig, BattleVerdict, CandidateRunResult } from "./types";
import { summarizeBattleResults } from "./types";
import { allocateBattleWorktree, cleanupBattleWorktree, getBattleDiff } from "./worktree-allocator";

const execAsync = promisify(exec);

export type BattleWorkerFn = (worktreePath: string, candidateId: string) => Promise<void>;

export interface BattleRunnerOptions {
	worker?: BattleWorkerFn;
	cleanupLosers?: boolean;
	onProgress?: (candidateId: string, status: string) => void;
}

/**
 * Runs a verification test command inside the worktree directory.
 */
async function runTestCommand(worktreePath: string, testCommand: string): Promise<{ passed: boolean; output: string }> {
	try {
		const { stdout, stderr } = await execAsync(testCommand, {
			cwd: worktreePath,
			timeout: 120_000,
		});
		return {
			passed: true,
			output: (stdout + (stderr ? `\n${stderr}` : "")).trim(),
		};
	} catch (error: any) {
		const out = (error.stdout || "") + (error.stderr ? `\n${error.stderr}` : error.message);
		return {
			passed: false,
			output: out.trim(),
		};
	}
}

/**
 * Executes a full battle session across all specified candidates.
 */
export async function runBattle(
	config: BattleConfig,
	repoRoot: string,
	options: BattleRunnerOptions = {},
): Promise<BattleVerdict> {
	const { worker, cleanupLosers = true, onProgress } = options;

	// Execute all candidates in parallel
	const candidatePromises = config.candidates.map(async (candidate): Promise<CandidateRunResult> => {
		const t0 = Date.now();
		onProgress?.(candidate.id, "allocating worktree");

		const { worktreePath, branchName } = await allocateBattleWorktree(repoRoot, config.id, candidate.id);

		let success = false;
		let runError: string | undefined;

		try {
			onProgress?.(candidate.id, "running agent task");
			if (worker) {
				await worker(worktreePath, candidate.id);
			}
			success = true;
		} catch (err) {
			success = false;
			runError = String(err);
		}

		// Run automated test command if configured
		let testPassed: boolean | undefined;
		let testOutput: string | undefined;

		if (success && config.testCommand) {
			onProgress?.(candidate.id, "running verification test");
			const testResult = await runTestCommand(worktreePath, config.testCommand);
			testPassed = testResult.passed;
			testOutput = testResult.output;
		}

		// Gather git diff and metric summary
		const diffSummary = await getBattleDiff(worktreePath, "HEAD~1");
		const elapsedMs = Date.now() - t0;

		return {
			candidateId: candidate.id,
			worktreePath,
			branchName,
			success,
			error: runError,
			testPassed,
			testOutput,
			diffSummary,
			metrics: {
				elapsedMs,
				filesChanged: diffSummary.files.length,
				additions: diffSummary.totalAdditions,
				deletions: diffSummary.totalDeletions,
			},
		};
	});

	const results = await Promise.all(candidatePromises);
	const summary = summarizeBattleResults(results);
	const winnerId = summary.suggestedWinnerId;

	let merged = false;

	// Handle merge if requested and a winner is found
	if (config.autoMerge && winnerId) {
		const winner = results.find(r => r.candidateId === winnerId);
		if (winner) {
			try {
				await execAsync(`git merge ${winner.branchName}`, { cwd: repoRoot });
				merged = true;
			} catch {}
		}
	}

	// Clean up losing worktrees
	if (cleanupLosers) {
		for (const result of results) {
			if (result.candidateId !== winnerId) {
				await cleanupBattleWorktree(repoRoot, result.worktreePath, result.branchName, true);
			}
		}
	}

	const reasoning = winnerId
		? `Candidate "${winnerId}" chosen as battle winner (${summary.testPassingCandidates}/${summary.totalCandidates} candidates passed tests).`
		: "No candidate succeeded in producing a valid verified solution.";

	return {
		battleId: config.id,
		winnerCandidateId: winnerId,
		reasoning,
		results,
		merged,
	};
}
