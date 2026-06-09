/**
 * Eval harness runner — executes agents against eval tasks and scores results.
 *
 * Usage:
 *   bun evals/buffbench/run.ts [--agent aery] [--tasks eval-aery.json] [--parallel 1]
 */

import { parseArgs } from "util";
import { runAery } from "./agent-runner";
import { judgeWith3Models } from "./judge";
import type { EvalTask, EvalResult } from "./types";

function avg(results: EvalResult[], field: keyof EvalResult["score"]): number {
	if (results.length === 0) return 0;
	return results.reduce((sum, r) => sum + r.score[field], 0) / results.length;
}

async function main() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			agent: { type: "string", default: "aery" },
			tasks: { type: "string", default: "eval-aery.json" },
			parallel: { type: "string", default: "1" },
		},
	});

	const tasksFile = values.tasks ?? "eval-aery.json";
	const tasks: EvalTask[] = await Bun.file(new URL(tasksFile, import.meta.url)).json();
	const concurrency = Number(values.parallel ?? 1);
	const results: EvalResult[] = [];

	console.log(`Running ${tasks.length} tasks with concurrency ${concurrency}...\n`);

	for (let i = 0; i < tasks.length; i += concurrency) {
		const batch = tasks.slice(i, i + concurrency);
		const batchResults = await Promise.all(
			batch.map(async (task) => {
				const repoDir = `/tmp/eval-${task.id}-${Date.now()}`;
				console.log(`[${task.id}] Running...`);

				try {
					const result = await runAery(task, repoDir);
					console.log(`[${task.id}] Done in ${(result.durationMs / 1000).toFixed(1)}s, diff length: ${result.diff.length}`);

					if (result.diff.length > 0) {
						result.score = await judgeWith3Models(result, task);
						console.log(`[${task.id}] Score: completion=${result.score.completion} quality=${result.score.codeQuality} overall=${result.score.overall}`);
					} else {
						console.log(`[${task.id}] No diff produced — skipping judge`);
					}

					return result;
				} catch (err) {
					console.error(`[${task.id}] Failed:`, err);
					return {
						taskId: task.id,
						agent: values.agent ?? "aery",
						score: { completion: 0, codeQuality: 0, overall: 0, rationale: `Error: ${err}` },
						cost: 0,
						durationMs: 0,
						diff: "",
						trace: String(err),
					} as EvalResult;
				}
			}),
		);
		results.push(...batchResults);
	}

	// Summary
	console.log("\n=== Summary ===");
	console.log(`Tasks: ${results.length}`);
	console.log(`Avg completion: ${avg(results, "completion").toFixed(1)}`);
	console.log(`Avg code quality: ${avg(results, "codeQuality").toFixed(1)}`);
	console.log(`Avg overall: ${avg(results, "overall").toFixed(1)}`);
	console.log(`Avg duration: ${(results.reduce((s, r) => s + r.durationMs, 0) / results.length / 1000).toFixed(1)}s`);

	// Save results
	const outPath = new URL(`results-${Date.now()}.json`, import.meta.url);
	await Bun.write(outPath, JSON.stringify(results, null, 2));
	console.log(`\nResults saved to ${outPath.pathname}`);
}

main().catch(console.error);
