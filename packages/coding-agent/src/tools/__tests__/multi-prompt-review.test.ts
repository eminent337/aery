import { expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@aryee337/aery-ai";
import type { AgentToolContext } from "@aryee337/aery-core";
import { createFallbackModel } from "../best-of-n";
import {
	buildReviewPrompt,
	type MultiPromptFinding,
	MultiPromptReviewTool,
	parseReviewFindings,
	type ReviewGenerateFn,
	renderReviewReport,
} from "../multi-prompt-review";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock/reviewer",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeGenerate(reviewsByCall: string[]): ReviewGenerateFn {
	let call = 0;
	return async () => {
		const text = reviewsByCall[Math.min(call, reviewsByCall.length - 1)] ?? "";
		call += 1;
		return assistant(text);
	};
}

function makeContext(model: Model): AgentToolContext {
	return {
		modelRegistry: {
			find: () => model,
			getApiKey: async () => "mock-key",
		} as unknown as AgentToolContext["modelRegistry"],
		model,
	} as AgentToolContext;
}

test("parseReviewFindings extracts structured findings", () => {
	const text = [
		"FINDING P1: Fix missing error handling",
		"  The function swallows exceptions silently.",
		"FINDING P0: Requirement 3 is not addressed",
		"  No validation of the input format was added.",
	].join("\n");
	const findings = parseReviewFindings(text, "correctness");
	expect(findings).toHaveLength(2);
	expect(findings[0]).toMatchObject({ title: "Fix missing error handling", priority: "P1", focus: "correctness" });
	expect(findings[1]).toMatchObject({ title: "Requirement 3 is not addressed", priority: "P0" });
	expect(findings[1]?.body).toContain("validation");
});

test("parseReviewFindings returns empty for text without headers", () => {
	expect(parseReviewFindings("Looks good to me.", "security")).toHaveLength(0);
});

test("multi_prompt_review runs one review pass per focus and combines findings", async () => {
	const model = createFallbackModel("reviewer");
	const generate = makeGenerate([
		"FINDING P1: Add input validation\n  Validate the payload before use.",
		"FINDING P2: Handle empty result set\n  Return early when results is empty.",
		"FINDING P3: No issues found.",
	]);
	const tool = new MultiPromptReviewTool(generate);
	const result = await tool.execute(
		"call-1",
		{
			subject: "diff:\n+ function f() {}",
			context: "Implement feature X",
			prompts: ["correctness", "edge cases", "security"],
		},
		undefined,
		undefined,
		makeContext(model),
	);

	expect(result.details?.focuses).toHaveLength(3);
	expect(result.details?.reviews).toHaveLength(3);
	expect(result.details?.findings.length).toBeGreaterThanOrEqual(3);
	expect(result.details?.findings.some(finding => finding.priority === "P0")).toBe(false);
	expect(result.content[0]?.type).toBe("text");
});

test("multi_prompt_review defaults to three focuses when prompts omitted", async () => {
	const model = createFallbackModel("reviewer");
	const generate = makeGenerate(["FINDING P3: No issues found."]);
	const tool = new MultiPromptReviewTool(generate);
	const result = await tool.execute("call-1", { subject: "diff" }, undefined, undefined, makeContext(model));
	expect(result.details?.focuses).toHaveLength(3);
	expect(result.details?.model).toBe("mock/reviewer");
});

test("multi_prompt_review tolerates a failing review pass", async () => {
	const model = createFallbackModel("reviewer");
	let call = 0;
	const generate: ReviewGenerateFn = async () => {
		call += 1;
		if (call === 2) throw new Error("boom");
		return assistant("FINDING P1: Fix the bug\n  There is a bug here.");
	};
	const tool = new MultiPromptReviewTool(generate);
	const result = await tool.execute(
		"call-1",
		{ subject: "diff", prompts: ["one", "two", "three"] },
		undefined,
		undefined,
		makeContext(model),
	);
	expect(result.details?.reviews).toHaveLength(2);
	expect(result.details?.findings.length).toBeGreaterThanOrEqual(1);
});

test("multi_prompt_review rejects an empty subject", async () => {
	const model = createFallbackModel("reviewer");
	const tool = new MultiPromptReviewTool(makeGenerate(["x"]));
	await expect(tool.execute("call-1", { subject: "   " }, undefined, undefined, makeContext(model))).rejects.toThrow(
		"subject is required",
	);
});

test("renderReviewReport includes priorities and focuses", () => {
	const details = {
		focuses: ["correctness"],
		reviews: [{ focus: "correctness", text: "FINDING P2: Tighten types\n  Use precise types." }],
		findings: [
			{
				title: "Tighten types",
				priority: "P2",
				body: "Use precise types.",
				focus: "correctness",
			} as MultiPromptFinding,
		],
		model: "mock/reviewer",
	};
	const report = renderReviewReport(details);
	expect(report).toContain("[P2] Tighten types");
	expect(report).toContain("mock/reviewer");
});

test("buildReviewPrompt includes the requirement context when provided", () => {
	const prompt = buildReviewPrompt("diff", "correctness", "Requirement: handle empty input");
	expect(prompt).toContain("Requirement: handle empty input");
	expect(prompt).toContain("FINDING P<0-3>");
});
