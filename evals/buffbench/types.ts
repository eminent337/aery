/**
 * Eval harness types — ported from Freebuff's BuffBench framework.
 *
 * Uses real git commits as ground truth. Agents reconstruct the commit
 * from a natural language prompt. AI judges score completion, code quality,
 * and overall quality on 0-10 scales.
 */

export interface EvalTask {
	/** Unique task identifier. */
	id: string;
	/** Repository URL to clone. */
	repository: string;
	/** Target commit SHA (the diff to reconstruct). */
	sha: string;
	/** Parent commit SHA (starting point). */
	parentSha: string;
	/** Natural language prompt given to the agent. */
	prompt: string;
	/** Detailed technical specification. */
	spec: string;
	/** Files to provide as context (beyond what the agent discovers). */
	supplementalFiles: string[];
	/** Expected unified diffs (ground truth). */
	fileDiffs: string[];
}

export interface EvalResult {
	taskId: string;
	agent: string;
	score: JudgeScore;
	cost: number;
	durationMs: number;
	/** The actual diff produced by the agent. */
	diff: string;
	/** Execution trace (stdout + stderr). */
	trace: string;
}

export interface JudgeScore {
	completion: number;
	codeQuality: number;
	overall: number;
	rationale: string;
}
