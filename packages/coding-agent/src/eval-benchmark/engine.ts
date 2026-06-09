/**
 * Eval Engine — pure state machine that scores tool-call events against
 * benchmark evaluation rules.
 *
 * Simplified to work
 * without the Behaviours dependency. Each rule is a self-contained
 * (name, matcher, expected) triple.
 */

import type { BenchmarkEval, EvalCounters, EvalEvent, EvalSnapshot, EvalVerdict } from "./types.js";

/** Default cap: at most 5 sample events per (rule, verdict) per session. */
export const EVAL_SAMPLE_CAP = 5;

export class EvalEngine {
	private readonly counters = new Map<string, EvalCounters>();
	private readonly emitted = new Map<string, EvalCounters>();
	private evaluated = 0;
	private turnIndex = 0;

	constructor(
		private readonly evals: readonly BenchmarkEval[],
		private readonly cap: number = EVAL_SAMPLE_CAP,
	) {}

	/**
	 * Advance the internal turn counter.
	 * Call once per agent turn before evaluating events from that turn.
	 */
	nextTurn(): void {
		this.turnIndex++;
	}

	/**
	 * Score a tool-call event against all loaded evaluation rules.
	 * Returns sample events for verdicts that fired on this event AND are still
	 * under the per-(rule, verdict) cap. Counters always advance even when
	 * sample emission is suppressed.
	 */
	evaluate(toolName: string, input: Record<string, unknown>): EvalEvent[] {
		this.evaluated++;
		const out: EvalEvent[] = [];

		for (const rule of this.evals) {
			try {
				if (!rule.matcher({ toolName, input })) continue;
				this.bump(rule.name, rule.expected);
				if (!this.tryEmit(rule.name, rule.expected)) continue;
				out.push({
					name: rule.name,
					verdict: rule.expected,
					turnIndex: this.turnIndex,
					toolName,
					toolArgs: input,
				});
			} catch {
				// Malformed matchers are silently skipped.
			}
		}

		return out;
	}

	/** Get uncapped counters for a specific rule. */
	countersFor(name: string): EvalCounters {
		return this.cloneCounters(this.counters.get(name));
	}

	/** Snapshot of all counters and state. */
	snapshot(): EvalSnapshot {
		const byRule: Record<string, EvalCounters> = {};
		for (const rule of this.evals) {
			byRule[rule.name] = this.cloneCounters(this.counters.get(rule.name));
		}
		return {
			byRule,
			totalEvaluated: this.evaluated,
			turnCount: this.turnIndex,
		};
	}

	/** Drop all counters and sample budgets. */
	reset(): void {
		this.counters.clear();
		this.emitted.clear();
		this.evaluated = 0;
		this.turnIndex = 0;
	}

	private bump(name: string, verdict: EvalVerdict): void {
		const c = this.counters.get(name) ?? { observed: 0, violated: 0 };
		c[verdict] += 1;
		this.counters.set(name, c);
	}

	private tryEmit(name: string, verdict: EvalVerdict): boolean {
		const e = this.emitted.get(name) ?? { observed: 0, violated: 0 };
		if (e[verdict] >= this.cap) return false;
		e[verdict] += 1;
		this.emitted.set(name, e);
		return true;
	}

	private cloneCounters(c: EvalCounters | undefined): EvalCounters {
		return c ? { ...c } : { observed: 0, violated: 0 };
	}
}
