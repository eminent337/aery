/**
 * Eval Benchmark Extension — monitors tool-call events and tracks
 * agent behavior metrics.
 *
 * Hooks into `tool_call` and `turn_start` events to evaluate each
 * tool invocation against configured benchmark rules. Results are
 * exposed via the `/eval-stats` slash command.
 *
 * Usage:
 *   createEvalBenchmarkExtension()
 *   createEvalBenchmarkExtension({ evals: myCustomEvals })
 *
 * If no custom evals are provided, the default rule set is used.
 */

import { defaultEvals } from "../eval-benchmark/default-evals.js";
import { EvalEngine } from "../eval-benchmark/engine.js";
import type { BenchmarkEval } from "../eval-benchmark/types.js";
import type { ExtensionAPI } from "../extensibility/extensions/types.js";

export interface EvalBenchmarkOptions {
	evals?: readonly BenchmarkEval[];
}

/**
 * Format a snapshot of eval counters into a human-readable string.
 */
function formatEvalSummary(engine: EvalEngine): string {
	const snap = engine.snapshot();
	const lines: string[] = [];
	lines.push(`Eval Benchmark — ${snap.totalEvaluated} tool calls evaluated across ${snap.turnCount} turns`);
	lines.push("");

	for (const [name, counters] of Object.entries(snap.byRule)) {
		const total = counters.observed + counters.violated;
		const verdict = counters.observed > 0 ? "✓" : counters.violated > 0 ? "✗" : "–";
		lines.push(`  ${verdict} ${name}: ${counters.observed} observed, ${counters.violated} violated (${total} total)`);
	}

	return lines.join("\n");
}

export function createEvalBenchmarkExtension(options?: EvalBenchmarkOptions) {
	const rules = options?.evals ?? defaultEvals();
	const engine = new EvalEngine(rules);

	return function evalBenchmarkExtension(api: ExtensionAPI): void {
		// ── turn_start: advance turn counter ──────────────────────────────────
		api.on("turn_start", () => {
			engine.nextTurn();
		});

		// ── tool_call: evaluate the tool call against all rules ──────────────
		api.on("tool_call", event => {
			if (event.type !== "tool_call") return;
			engine.evaluate(event.toolName, event.input as Record<string, unknown>);
		});

		// ── /eval-stats command ──────────────────────────────────────────────
		api.registerCommand("eval-stats", {
			description: "Show current eval benchmark statistics",
			handler: async _args => {
				api.logger.info(formatEvalSummary(engine));
			},
		});
	};
}
