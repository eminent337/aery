/**
 * Agent runner — executes coding agent CLIs in isolated repos.
 *
 * Ported from Freebuff's BuffBench agent-runner.ts pattern.
 * Supports Aery and Freebuff runners for cross-agent comparison.
 */

import { $ } from "bun";
import type { EvalTask, EvalResult } from "./types";

async function cloneAndCheckout(task: EvalTask, repoDir: string): Promise<void> {
	await $`git clone --quiet ${task.repository} ${repoDir}`;
	await $`git checkout --quiet ${task.parentSha}`.cwd(repoDir);
}

async function captureDiff(repoDir: string): Promise<string> {
	const diffResult = await $`git diff`.cwd(repoDir).quiet().nothrow();
	return diffResult.exitCode === 0 ? diffResult.text() : "";
}

function wrapResult(task: EvalResult, diff: string, trace: string, durationMs: number): EvalResult {
	return { ...task, diff, trace, durationMs };
}

export async function runAery(
	task: EvalTask,
	repoDir: string,
	timeoutMs = 60 * 60 * 1000,
): Promise<EvalResult> {
	const start = Date.now();
	await cloneAndCheckout(task, repoDir);

	const proc = Bun.spawn(
		["bun", "--cwd", "/home/aryee/aery/ai_agent/aery/packages/coding-agent", "src/cli.ts", "-p", task.prompt, "--yolo"],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	);

	const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	clearTimeout(timer);

	return wrapResult(
		{ ...task, agent: "aery", score: { completion: 0, codeQuality: 0, overall: 0, rationale: "" }, cost: 0, durationMs: 0, diff: "", trace: "" },
		await captureDiff(repoDir),
		stdout + stderr,
		Date.now() - start,
	);
}

export async function runFreebuff(
	task: EvalTask,
	repoDir: string,
	timeoutMs = 60 * 60 * 1000,
): Promise<EvalResult> {
	const start = Date.now();
	await cloneAndCheckout(task, repoDir);

	const proc = Bun.spawn(
		["bun", "--cwd", "/home/aryee/aery/ai_agent/freebuff", "freebuff/src/index.ts", "-p", task.prompt],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	);

	const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	clearTimeout(timer);

	return wrapResult(
		{ ...task, agent: "freebuff", score: { completion: 0, codeQuality: 0, overall: 0, rationale: "" }, cost: 0, durationMs: 0, diff: "", trace: "" },
		await captureDiff(repoDir),
		stdout + stderr,
		Date.now() - start,
	);
}
