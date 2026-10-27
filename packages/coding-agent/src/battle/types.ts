/**
 * Types and helper functions for Aery Worktree Battle Mode.
 *
 * Facilitates parallel speculative task execution across isolated git worktrees,
 * automated testing, candidate scoring, and merge arbitration.
 */

export interface BattleCandidateSpec {
	id: string;
	label?: string;
	model?: string;
	prompt?: string;
	temperature?: number;
	thinkingLevel?: string;
}

export interface BattleConfig {
	/** Ephemeral battle session ID */
	id: string;
	/** Problem description or objective */
	objective: string;
	/** List of parallel candidates to evaluate */
	candidates: BattleCandidateSpec[];
	/** Optional verification test command (e.g. "bun test", "npm test") */
	testCommand?: string;
	/** Timeout in milliseconds per candidate turn */
	timeoutMs?: number;
	/** Whether to automatically merge the winner into the current branch upon completion */
	autoMerge?: boolean;
}

export interface DiffFileChange {
	path: string;
	status: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
}

export interface DiffSummary {
	files: DiffFileChange[];
	patch: string;
	totalAdditions: number;
	totalDeletions: number;
}

export interface CandidateRunResult {
	candidateId: string;
	worktreePath: string;
	branchName: string;
	success: boolean;
	error?: string;
	testPassed?: boolean;
	testOutput?: string;
	diffSummary?: DiffSummary;
	metrics: {
		elapsedMs: number;
		totalTokens?: number;
		filesChanged: number;
		additions: number;
		deletions: number;
	};
}

export interface BattleSummary {
	totalCandidates: number;
	successfulRuns: number;
	testPassingCandidates: number;
	suggestedWinnerId?: string;
}

export interface BattleVerdict {
	battleId: string;
	winnerCandidateId?: string;
	reasoning: string;
	results: CandidateRunResult[];
	merged: boolean;
}

/**
 * Evaluates candidate execution results and selects the suggested winner.
 * Preference order:
 * 1. Passed test suite
 * 2. Successful agent run with non-empty diff
 * 3. Minimal unnecessary line churn
 */
export function summarizeBattleResults(results: CandidateRunResult[]): BattleSummary {
	const totalCandidates = results.length;
	const successfulRuns = results.filter(r => r.success).length;
	const passing = results.filter(r => r.success && r.testPassed === true);

	let suggestedWinnerId: string | undefined;

	if (passing.length > 0) {
		// If multiple passed tests, pick the one with cleanest churn (or fastest)
		passing.sort(
			(a, b) => a.metrics.filesChanged - b.metrics.filesChanged || a.metrics.elapsedMs - b.metrics.elapsedMs,
		);
		suggestedWinnerId = passing[0].candidateId;
	} else {
		// Fall back to any successful run
		const anySuccess = results.filter(r => r.success && (r.metrics.additions > 0 || r.metrics.filesChanged > 0));
		if (anySuccess.length > 0) {
			suggestedWinnerId = anySuccess[0].candidateId;
		}
	}

	return {
		totalCandidates,
		successfulRuns,
		testPassingCandidates: passing.length,
		suggestedWinnerId,
	};
}

export function isBattleSuccessful(results: CandidateRunResult[]): boolean {
	return results.some(r => r.success && (r.testPassed === true || r.metrics.filesChanged > 0));
}
