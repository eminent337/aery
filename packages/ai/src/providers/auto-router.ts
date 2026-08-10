/**
 * Aery Auto Router Provider.
 * Automatically classifies incoming prompts by task type and context size,
 * then executes through a prioritized chain of free models with failover.
 */
import { stream } from "../stream";
import type { Api, AssistantMessageEvent, Context, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

export interface AutoRouterOptions extends StreamOptions {
	/** Force a specific task tier: "fast" | "reasoning" | "long-context" */
	tierOverride?: "fast" | "reasoning" | "long-context";
}

export type TaskTier = "fast" | "reasoning" | "long-context";

export interface CandidateModelSpec {
	provider: string;
	id: string;
	api: Api;
	contextWindow: number;
}

// Priority chains per task tier containing all active free models
const FAST_TIER_CANDIDATES: CandidateModelSpec[] = [
	{
		provider: "google-antigravity",
		id: "gemini-3.6-flash-high",
		api: "google-gemini-cli",
		contextWindow: 1048576,
	},
	{
		provider: "zenmux",
		id: "sapiens-ai/agnes-2.5-flash",
		api: "openai-completions",
		contextWindow: 128000,
	},
	{
		provider: "kiro",
		id: "claude-haiku-4.5",
		api: "kiro-cli",
		contextWindow: 200000,
	},
	{
		provider: "opencode-go",
		id: "deepseek-v4-flash",
		api: "openai-completions",
		contextWindow: 128000,
	},
	{
		provider: "google-antigravity",
		id: "gemini-2.5-flash",
		api: "google-gemini-cli",
		contextWindow: 1048576,
	},
	{
		provider: "kilo",
		id: "~anthropic/claude-haiku-latest",
		api: "anthropic-messages",
		contextWindow: 200000,
	},
	{
		provider: "opencode-zen",
		id: "claude-haiku-4-5",
		api: "openai-completions",
		contextWindow: 200000,
	},
];
const REASONING_TIER_CANDIDATES: CandidateModelSpec[] = [
	{
		provider: "kiro",
		id: "claude-sonnet-4.5",
		api: "kiro-cli",
		contextWindow: 200000,
	},
	{
		provider: "opencode-go",
		id: "deepseek-v4-flash",
		api: "openai-completions",
		contextWindow: 128000,
	},
	{
		provider: "google-antigravity",
		id: "gemini-pro-agent",
		api: "google-gemini-cli",
		contextWindow: 1048576,
	},
	{
		provider: "nvidia",
		id: "deepseek-ai/deepseek-v4-pro",
		api: "openai-completions",
		contextWindow: 128000,
	},
	{
		provider: "kilo",
		id: "~anthropic/claude-sonnet-latest",
		api: "anthropic-messages",
		contextWindow: 200000,
	},
	{
		provider: "opencode-zen",
		id: "claude-sonnet-4-6",
		api: "openai-completions",
		contextWindow: 200000,
	},
	{
		provider: "google-antigravity",
		id: "gemini-2.5-pro",
		api: "google-gemini-cli",
		contextWindow: 2097152,
	},
];
const LONG_CONTEXT_TIER_CANDIDATES: CandidateModelSpec[] = [
	{
		provider: "google-antigravity",
		id: "gemini-3.6-flash-high",
		api: "google-gemini-cli",
		contextWindow: 1048576,
	},
	{
		provider: "google-antigravity",
		id: "gemini-2.5-pro",
		api: "google-gemini-cli",
		contextWindow: 2097152,
	},
	{
		provider: "kiro",
		id: "auto",
		api: "kiro-cli",
		contextWindow: 1000000,
	},
	{
		provider: "opencode-go",
		id: "deepseek-v4-pro",
		api: "openai-completions",
		contextWindow: 128000,
	},
	{
		provider: "kilo",
		id: "~anthropic/claude-sonnet-latest",
		api: "anthropic-messages",
		contextWindow: 200000,
	},
];

export function classifyTask(context: Context, override?: TaskTier): TaskTier {
	if (override) return override;

	let totalChars = context.systemPrompt?.length || 0;
	let isCodeTask = false;

	for (const msg of context.messages) {
		const contentStr =
			typeof msg.content === "string"
				? msg.content
				: msg.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		totalChars += contentStr.length;

		if (
			contentStr.includes("```") ||
			contentStr.includes("function") ||
			contentStr.includes("class") ||
			contentStr.includes("import ") ||
			contentStr.includes("diff") ||
			contentStr.includes("refactor") ||
			contentStr.includes("fix") ||
			contentStr.includes("debug")
		) {
			isCodeTask = true;
		}
	}

	const estimatedTokens = Math.ceil(totalChars / 4);

	// Over 50,000 estimated tokens -> long-context tier
	if (estimatedTokens > 50000) {
		return "long-context";
	}

	// Code tasks or detailed prompts -> reasoning tier
	if (isCodeTask || estimatedTokens > 1000) {
		return "reasoning";
	}

	// Quick queries -> fast tier
	return "fast";
}

function getCandidatesForTier(tier: TaskTier): CandidateModelSpec[] {
	switch (tier) {
		case "long-context":
			return LONG_CONTEXT_TIER_CANDIDATES;
		case "reasoning":
			return REASONING_TIER_CANDIDATES;
		case "fast":
			return FAST_TIER_CANDIDATES;
	}
}

function specToModel(spec: CandidateModelSpec): Model<Api> {
	return {
		id: spec.id,
		name: spec.id,
		api: spec.api,
		provider: spec.provider,
		baseUrl: "auto",
		reasoning: spec.id.includes("pro") || spec.id.includes("thinking") || spec.id.includes("sonnet"),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: spec.contextWindow,
		maxTokens: 8192,
	};
}

/**
 * Stream using the Auto Router: classifies prompt, tries primary model,
 * and seamlessly fails over to secondary/tertiary candidates if errors occur.
 */
export function streamAutoRouter(
	_model: Model<"auto-router">,
	context: Context,
	options?: AutoRouterOptions,
): AssistantMessageEventStream {
	const streamEventStream = new AssistantMessageEventStream();

	(async () => {
		const tier = classifyTask(context, options?.tierOverride);
		const candidates = getCandidatesForTier(tier);

		let lastError: unknown = null;

		for (const spec of candidates) {
			try {
				const candidateModel = specToModel(spec);
				const candidateStream = stream(candidateModel, context, options);

				const events: AssistantMessageEvent[] = [];
				for await (const event of candidateStream) {
					events.push(event);
					streamEventStream.push(event);
				}

				const result = await candidateStream.result();
				streamEventStream.end(result);
				return;
			} catch (err) {
				lastError = err;
			}
		}

		// If all candidates failed
		streamEventStream.fail(lastError || new Error(`All candidate models failed for tier ${tier}`));
	})();

	return streamEventStream;
}
