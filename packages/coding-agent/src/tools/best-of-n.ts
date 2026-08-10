/**
 * Best-of-N tool — generates N parallel candidate solutions and selects the best.
 *
 * Ported from Freebuff's `thinker/best-of-n` agent architecture:
 * - The `GENERATE_N` primitive becomes N parallel `generateComplete` calls.
 * - The `thinker-selector` subagent becomes a single selector generation that
 *   evaluates every candidate and returns the chosen id.
 *
 * The tool is failure-tolerant: if some candidate generations fail (rate limit,
 * transient network error), the survivors are still evaluated and returned.
 */

import type { Api, AssistantMessage, Context, GenerateOptionsUnified, Model, TextContent } from "@aryee337/aery-ai";
import { generateComplete } from "@aryee337/aery-ai";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { parseModelString } from "../config/model-resolver";
import { ToolError } from "./tool-errors";

const bestOfNSchema = z.object({
	prompt: z
		.string()
		.describe(
			"The problem to solve. Include all necessary context inline — candidate generations cannot see the conversation history.",
		),
	n: z
		.number()
		.int()
		.min(1)
		.max(6)
		.optional()
		.default(3)
		.describe(
			"Number of candidate solutions to generate in parallel. Defaults to 3; use up to 6 for complex problems.",
		),
	model: z
		.string()
		.optional()
		.describe("Optional model selector (e.g. 'aery/auto', 'kiro/claude-sonnet-4.5'). Defaults to the current model."),
});

export interface BestOfNCandidate {
	id: string;
	text: string;
}

export interface BestOfNDetails {
	n: number;
	candidates: BestOfNCandidate[];
	chosenId: string;
	chosenText: string;
	model: string;
	selectionRationale?: string;
}

export type GenerateCompleteFn = (
	model: Model<Api>,
	context: Context,
	options?: GenerateOptionsUnified,
) => Promise<AssistantMessage>;

const CANDIDATE_ID_PREFIX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Extract visible text from an assistant message, dropping thinking blocks. */
export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

/** Build a minimal mock model used when no registry/context is available (tests, headless). */
export function createFallbackModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "mock",
		baseUrl: "https://mock.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

/**
 * Resolve the generation model from a selector string and the tool context.
 * Order: explicit selector via modelRegistry → current session model → mock fallback.
 */
export async function resolveGenerationModel(
	selector: string | undefined,
	context: AgentToolContext | undefined,
): Promise<Model<Api>> {
	const registry = context?.modelRegistry;
	if (registry) {
		if (selector) {
			const parsed = parseModelString(selector);
			if (parsed) {
				const found = registry.find(parsed.provider, parsed.id);
				if (found) return found;
			}
		}
		if (context?.model) return context.model;
	}
	return createFallbackModel(selector ?? "best-of-n");
}

/** Locate the chosen candidate id inside the selector's output text. */
export function parseChosenCandidateId(text: string, candidateIds: string[]): string | undefined {
	const candidates = new Set(candidateIds);
	const trimmed = text.trim();
	// A bare letter (or bracketed letter) answer.
	const letterMatch = /^[\s([]*([A-Z])[\s)\]]*$/.exec(trimmed);
	if (letterMatch && candidates.has(letterMatch[1])) return letterMatch[1];
	// First standalone candidate id token anywhere in the output.
	const words = trimmed.split(/[\s,;:.]+/);
	for (const word of words) {
		if (candidates.has(word)) return word;
	}
	// Id quoted inside text like `"B"` or `(B)`.
	for (const id of candidateIds) {
		if (new RegExp(`\\b\\(?${id}\\)?\\b`).test(trimmed)) return id;
	}
	return undefined;
}

export function buildSelectorPrompt(problem: string, candidates: BestOfNCandidate[]): string {
	const lines = candidates.map(candidate => `${candidate.id}:\n${candidate.text}`);
	return `You are a selector agent. You have been provided with ${candidates.length} candidate solution(s) to the following problem:

${problem}

Candidates:

${lines.join("\n\n")}

Evaluate each candidate on (in order of importance):
1. Depth and thoroughness in addressing the problem.
2. Correctness and accuracy.
3. Clarity and organization.
4. Practical actionability.
5. Consideration of edge cases and alternatives.

Respond with exactly one line containing the letter of the best candidate (e.g. "${candidates[0]?.id}"). Do not include any other text.`;
}

export class BestOfNTool implements AgentTool<typeof bestOfNSchema, BestOfNDetails> {
	readonly loadMode = "discoverable" as const;
	readonly name = "best_of_n";
	readonly approval = "read" as const;
	readonly label = "Best-of-N Generator";
	readonly summary = "Generates N parallel candidate solutions and selects the best one.";
	readonly description =
		"Generates N candidate solutions to a problem in parallel, then runs a selector pass that evaluates all candidates and returns only the best one. Use for complex reasoning or open-ended designs where trying multiple approaches improves quality. Candidates cannot see the conversation history, so include all relevant context in the prompt.";
	readonly parameters = bestOfNSchema;

	#generate: GenerateCompleteFn;

	constructor(generateOverride?: GenerateCompleteFn) {
		this.#generate = generateOverride ?? generateComplete;
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof bestOfNSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BestOfNDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<BestOfNDetails>> {
		const prompt = params.prompt.trim();
		if (!prompt) throw new ToolError("best_of_n: prompt is required and must not be empty.");
		const n = params.n ?? 3;
		const model = await resolveGenerationModel(params.model, context);
		const modelSelector = `${model.provider}/${model.id}`;

		const apiKey = context?.modelRegistry ? await context.modelRegistry.getApiKey(model) : undefined;

		const generationContext: Context = {
			systemPrompt: [
				"Generate a complete, high-quality solution to the user's problem. Do not ask clarifying questions; make reasonable assumptions and state them briefly.",
			],
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};

		// GENERATE_N — run n parallel candidate generations, tolerant of failures.
		const attempts = await Promise.all(
			Array.from({ length: n }, async (_, index) => {
				try {
					const message = await this.#generate(model, generationContext, { apiKey });
					return {
						id: CANDIDATE_ID_PREFIX[index],
						text: extractAssistantText(message),
					} satisfies BestOfNCandidate;
				} catch (error) {
					return {
						id: CANDIDATE_ID_PREFIX[index],
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);

		const candidates = attempts.flatMap(candidate =>
			"text" in candidate && candidate.text ? [candidate] : [],
		) as BestOfNCandidate[];

		if (candidates.length === 0) {
			const failures = attempts
				.filter((candidate): candidate is { id: string; error: string } => "error" in candidate)
				.map(candidate => candidate.error)
				.join("; ");
			throw new ToolError(`best_of_n: all ${n} candidate generations failed. ${failures}`);
		}

		let chosen: BestOfNCandidate;
		let selectionRationale: string | undefined;
		if (candidates.length === 1) {
			chosen = candidates[0];
		} else {
			const selector = await this.#selectBest(prompt, candidates, model, context, apiKey);
			chosen = selector.candidate;
			selectionRationale = selector.rationale;
		}

		const details: BestOfNDetails = {
			n,
			candidates,
			chosenId: chosen.id,
			chosenText: chosen.text,
			model: modelSelector,
			...(selectionRationale !== undefined ? { selectionRationale } : {}),
		};

		const header = `Best-of-N selection (${candidates.length}/${n} candidates, ${modelSelector}):\n\n`;
		return {
			content: [{ type: "text", text: header + chosen.text }],
			details,
		};
	}

	async #selectBest(
		problem: string,
		candidates: BestOfNCandidate[],
		model: Model<Api>,
		context: AgentToolContext | undefined,
		apiKey: string | undefined,
	): Promise<{ candidate: BestOfNCandidate; rationale?: string }> {
		const selectorContext: Context = {
			systemPrompt: [
				"You are a thinking-output selector. Choose the single best candidate solution for the given problem.",
			],
			messages: [{ role: "user", content: buildSelectorPrompt(problem, candidates), timestamp: Date.now() }],
		};
		try {
			const message = await this.#generate(model, selectorContext, { apiKey });
			const output = extractAssistantText(message);
			const chosenId = parseChosenCandidateId(
				output,
				candidates.map(candidate => candidate.id),
			);
			const chosen = candidates.find(candidate => candidate.id === chosenId);
			if (chosen) {
				return { candidate: chosen, rationale: output.length > 80 ? output : undefined };
			}
			// Selector output was unparseable — fall back to the first candidate.
			return {
				candidate: candidates[0],
				rationale: `Selector output unparseable; fell back to first candidate: ${output.slice(0, 200)}`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				candidate: candidates[0],
				rationale: `Selector generation failed (${message}); fell back to first candidate.`,
			};
		}
	}
}
