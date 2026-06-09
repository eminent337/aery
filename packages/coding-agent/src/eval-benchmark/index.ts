/**
 * Eval Benchmark index — re-exports public API.
 */

export { defaultEvals } from "./default-evals.js";
export { EVAL_SAMPLE_CAP, EvalEngine } from "./engine.js";
export type {
	BenchmarkEval,
	EvalCounters,
	EvalEvent,
	EvalMatcher,
	EvalSnapshot,
	EvalVerdict,
} from "./types.js";
