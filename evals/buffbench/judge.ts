/**
 * 3-model AI judge with median scoring — ported from Freebuff's BuffBench.
 *
 * Three judges run in parallel (Claude, GPT, Gemini). Median score is used
 * for robustness against individual model biases.
 */

import type { EvalResult, JudgeScore } from "./types";

const JUDGE_PROMPT = `You are a code review judge. Score this agent's work on a coding task.

Task: {prompt}

Expected diff (ground truth):
{expectedDiff}

Agent's actual diff:
{actualDiff}

Score on three dimensions (0-10):
1. completion: How much of the task was completed?
2. codeQuality: Is the code correct, clean, and well-structured?
3. overall: Overall quality of the solution

Respond with JSON only: { "completion": N, "codeQuality": N, "overall": N, "rationale": "..." }`;

async function callJudge(
	prompt: string,
	model: string,
	apiKey: string,
): Promise<JudgeScore> {
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model,
			max_tokens: 1024,
			messages: [{ role: "user", content: prompt }],
		}),
	});

	if (!response.ok) {
		throw new Error(`Judge API error: ${response.status} ${await response.text()}`);
	}

	const data = await response.json() as { content: Array<{ text: string }> };
	const text = data.content[0]?.text ?? "";
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error(`Judge returned invalid JSON: ${text}`);
	return JSON.parse(match[0]) as JudgeScore;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function judgeWith3Models(
	result: EvalResult,
	task: { prompt: string; fileDiffs: string[] },
): Promise<JudgeScore> {
	const prompt = JUDGE_PROMPT
		.replace("{prompt}", task.prompt)
		.replace("{expectedDiff}", task.fileDiffs.join("\n"))
		.replace("{actualDiff}", result.diff);

	const judges = [
		callJudge(prompt, "claude-sonnet-4-20250514", process.env.ANTHROPIC_API_KEY ?? ""),
		callJudge(prompt, "gpt-4o", process.env.OPENAI_API_KEY ?? ""),
		callJudge(prompt, "gemini-2.5-pro", process.env.GOOGLE_API_KEY ?? ""),
	];

	const results = await Promise.allSettled(judges);
	const valid = results
		.filter((r): r is PromiseFulfilledResult<JudgeScore> => r.status === "fulfilled")
		.map((r) => r.value);

	if (valid.length === 0) {
		throw new Error(`All judges failed: ${results.map((r) => r.status === "rejected" ? r.reason?.message : "unknown").join(", ")}`);
	}

	return {
		completion: median(valid.map((s) => s.completion)),
		codeQuality: median(valid.map((s) => s.codeQuality)),
		overall: median(valid.map((s) => s.overall)),
		rationale: valid[0].rationale,
	};
}
