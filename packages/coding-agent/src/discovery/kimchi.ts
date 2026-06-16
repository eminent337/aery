/**
 * Kimchi (Cast AI) Provider
 *
 * Registers the kimchi OAuth provider and model definitions.
 * Models are registered at startup so they survive restarts.
 * Login only handles the Cast AI API key credential storage.
 */
import { registerOAuthProvider } from "@aryee337/aery-ai/utils/oauth";
import type { OAuthProviderInterface } from "@aryee337/aery-ai/utils/oauth/types";
import type { ModelRegistry } from "../config/model-registry";

export const KIMCHI_PROVIDER_ID = "kimchi";
export const KIMCHI_CHAT_URL = "https://llm.kimchi.dev/openai/v1";

const kimchiProvider: OAuthProviderInterface = {
	id: KIMCHI_PROVIDER_ID,
	name: "Kimchi (Cast AI)",

	login: async callbacks => {
		return await callbacks.onPrompt({
			message: "Paste your Cast AI API key:",
			placeholder: "castai_v1_...",
		});
	},
	refreshToken: credentials => Promise.resolve(credentials),
	getApiKey: credentials => credentials.access,
};

registerOAuthProvider(kimchiProvider);
/** Model definitions for kimchi/CastAI. These are hardcoded from the metadata API. */
export const KIMCHI_MODELS: Array<{
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}> = [
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "qwen3-coder-next-fp8",
		name: "Qwen3 Coder Next FP8",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		id: "nemotron-3-ultra-fp4",
		name: "Nemotron 3 Ultra FP4",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_000,
	},
	{
		id: "nemotron-3-super-fp4",
		name: "Nemotron 3 Super FP4",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_000,
	},
	{
		id: "minimax-m3",
		name: "MiniMax M3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

/**
 * Register kimchi models with a ModelRegistry.
 * Called at startup so models persist across app restarts.
 */
export function registerKimchiModels(registry: ModelRegistry): void {
	const models = KIMCHI_MODELS.map(m => ({
		...m,
		api: "openai-completions" as const,
		baseUrl: KIMCHI_CHAT_URL,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			reasoningEffortMap: {
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "medium",
				xhigh: "medium",
			},
		},
	}));

	registry.registerProvider(KIMCHI_PROVIDER_ID, {
		baseUrl: KIMCHI_CHAT_URL,
		api: "openai-completions",
		headers: { "User-Agent": "kimchi/0.1.17" },
		// Include oauth config to pass validation (apiKey is resolved through OAuth at runtime)
		oauth: {
			name: kimchiProvider.name,
			login: kimchiProvider.login,
			refreshToken: kimchiProvider.refreshToken,
			getApiKey: kimchiProvider.getApiKey,
		},
		models,
	});
}
