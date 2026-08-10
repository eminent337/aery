import { expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@aryee337/aery-ai";
import type { AgentToolContext } from "@aryee337/aery-core";
import {
	BestOfNTool,
	createFallbackModel,
	extractAssistantText,
	type GenerateCompleteFn,
	parseChosenCandidateId,
} from "../best-of-n";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock/best-of-n",
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

function makeGenerate(calls: string[]): GenerateCompleteFn {
	let index = 0;
	return async () => {
		const text = calls[Math.min(index, calls.length - 1)];
		index += 1;
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

test("best_of_n generates 3 candidates and picks via selector", async () => {
	const model = createFallbackModel("best-of-n");
	const generate = makeGenerate([
		"Candidate A: simple approach",
		"Candidate B: thorough approach",
		"Candidate C: alternative approach",
		"SELECTOR: B is the best because it handles all edge cases.",
	]);
	const tool = new BestOfNTool(generate);
	const result = await tool.execute(
		"call-1",
		{ prompt: "Solve the problem", n: 3 },
		undefined,
		undefined,
		makeContext(model),
	);

	expect(result.details?.n).toBe(3);
	expect(result.details?.candidates).toHaveLength(3);
	expect(result.details?.chosenId).toBe("B");
	expect(result.details?.chosenText).toContain("thorough approach");
	expect(result.content[0]?.type).toBe("text");
});

test("best_of_n returns the single candidate when n=1 without selector", async () => {
	const model = createFallbackModel("best-of-n");
	const generate = makeGenerate(["Only answer"]);
	const tool = new BestOfNTool(generate);
	const result = await tool.execute(
		"call-1",
		{ prompt: "Quick question", n: 1 },
		undefined,
		undefined,
		makeContext(model),
	);

	expect(result.details?.candidates).toHaveLength(1);
	expect(result.details?.chosenId).toBe("A");
	expect(result.details?.chosenText).toBe("Only answer");
});

test("best_of_n tolerates failed candidate generations", async () => {
	const model = createFallbackModel("best-of-n");
	let call = 0;
	const generate: GenerateCompleteFn = async () => {
		call += 1;
		if (call === 2) throw new Error("transient network error");
		if (call === 4) return assistant("SELECTOR: C");
		return assistant(`Candidate ${call}`);
	};
	const tool = new BestOfNTool(generate);
	const result = await tool.execute("call-1", { prompt: "Problem", n: 3 }, undefined, undefined, makeContext(model));

	expect(result.details?.candidates).toHaveLength(2);
	expect(result.details?.chosenId).toBe("C");
});

test("best_of_n throws ToolError when all generations fail", async () => {
	const model = createFallbackModel("best-of-n");
	const generate: GenerateCompleteFn = async () => {
		throw new Error("all upstream calls failing");
	};
	const tool = new BestOfNTool(generate);
	await expect(
		tool.execute("call-1", { prompt: "Problem", n: 3 }, undefined, undefined, makeContext(model)),
	).rejects.toThrow("all 3 candidate generations failed");
});

test("extractAssistantText drops thinking blocks", () => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden reasoning" },
			{ type: "text", text: "visible answer" },
		],
		api: "openai-completions",
		provider: "mock",
		model: "mock/best-of-n",
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
	expect(extractAssistantText(message)).toBe("visible answer");
});

test("parseChosenCandidateId extracts bare and inline letters", () => {
	const ids = ["A", "B", "C"];
	expect(parseChosenCandidateId("B", ids)).toBe("B");
	expect(parseChosenCandidateId("(C) — chosen for clarity", ids)).toBe("C");
	expect(parseChosenCandidateId("I pick A because it is concise", ids)).toBe("A");
	expect(parseChosenCandidateId("None of these", ids)).toBeUndefined();
});
