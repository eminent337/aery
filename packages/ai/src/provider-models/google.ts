import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";
import { fetchAntigravityDiscoveryModels } from "../utils/discovery/antigravity";
import { fetchGeminiModels } from "../utils/discovery/gemini";

export interface GoogleModelManagerConfig {
	apiKey?: string;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
	project?: string;
	location?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	resolveToken?: () => Promise<string | undefined> | string | undefined;
	endpoint?: string;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	resolveToken?: () => Promise<string | undefined> | string | undefined;
	endpoint?: string;
}

const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		...(apiKey ? { fetchDynamicModels: () => fetchGeminiModels({ apiKey }) } : undefined),
	};
}

export function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	return { providerId: "google-vertex" };
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const hasAuth = Boolean(config?.oauthToken || config?.resolveToken);
	return {
		providerId: "google-antigravity",
		// The Antigravity discovery endpoint is the authoritative catalog for the
		// provider: a successful fetch is the complete set of active models, so
		// static-only entries from bundled models.json are pruned.
		dynamicModelsAuthoritative: true,
		...(hasAuth
			? {
					fetchDynamicModels: async () => {
						const token = config?.resolveToken ? await config.resolveToken() : config?.oauthToken;
						if (!token) {
							return null;
						}
						return fetchAntigravityDiscoveryModels({
							token,
							endpoint: config?.endpoint,
						});
					},
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const hasAuth = Boolean(config?.oauthToken || config?.resolveToken);
	const endpoint = config?.endpoint ?? CLOUD_CODE_ASSIST_ENDPOINT;
	return {
		providerId: "google-gemini-cli",
		...(hasAuth
			? {
					fetchDynamicModels: async () => {
						const token = config?.resolveToken ? await config.resolveToken() : config?.oauthToken;
						if (!token) {
							return null;
						}
						const models = await fetchAntigravityDiscoveryModels({
							token,
							endpoint,
						});
						if (models === null) {
							return null;
						}
						return models.map(m => ({
							...m,
							provider: "google-gemini-cli" as const,
							baseUrl: endpoint,
						}));
					},
				}
			: undefined),
	};
}
