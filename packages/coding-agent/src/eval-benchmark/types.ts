/**
 * Eval Benchmark — types for agent behavior evaluation.
 *
 * Lightweight evaluation framework that scores tool-call events against
 * configurable matchers — just
 * a simple event → verdict pipeline with cap enforcement.
 *
 * Architecture:
 *   tool_call event → evaluate(evals, event) → EvalEvent[] (sample/verdict)
 *                                                 + counters advance
 */

/** Verdict for a single evaluation rule. */
export type EvalVerdict = "observed" | "violated";

/**
 * A reusable predicate on tool-call events.
 * Returns true when the tool call matches the rule's criteria.
 */
export type EvalMatcher = (event: { toolName: string; input: Record<string, unknown> }) => boolean;

/**
 * A single benchmark evaluation rule.
 * - `name`: unique identifier (shown in reports)
 * - `description`: human-readable explanation
 * - `matcher`: predicate that fires on matching tool calls
 * - `expected`: the verdict to track when the matcher fires (observed = good, violated = bad)
 */
export interface BenchmarkEval {
	name: string;
	description: string;
	matcher: EvalMatcher;
	expected: EvalVerdict;
}

/** Event emitted when a matcher fires and is under the sample cap. */
export interface EvalEvent {
	name: string;
	verdict: EvalVerdict;
	turnIndex: number;
	toolName: string;
	toolArgs: Record<string, unknown>;
}

/** Running counters for a single evaluation rule. */
export interface EvalCounters {
	observed: number;
	violated: number;
}

/** Snapshot of all eval counters at a point in time. */
export interface EvalSnapshot {
	/** Per-rule counters. */
	byRule: Record<string, EvalCounters>;
	/** Total tool calls evaluated. */
	totalEvaluated: number;
	/** Session turn count. */
	turnCount: number;
}
