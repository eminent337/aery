/**
 * Web Search Types
 *
 * Unified types for web search responses across supported providers.
 */

/** Supported web search providers — 4-tier cascade order */
export type SearchProviderId = "tavily" | "exa" | "parallel" | "ddg";

export function isSearchProviderId(value: string): value is SearchProviderId {
	return ["tavily", "exa", "parallel", "ddg"].includes(value);
}

export function isSearchProviderPreference(value: string): value is SearchProviderId | "auto" {
	return value === "auto" || isSearchProviderId(value);
}

/** Source returned by search (all providers) */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference */
export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	searchRequests?: number;
}

/** Unified response across providers */
export interface SearchResponse {
	provider: SearchProviderId | "none";
	/** Synthesized answer text */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode used by the provider (e.g. oauth, api-key) */
	authMode?: string;
}

/** Provider-specific error with optional HTTP status */
export class SearchProviderError extends Error {
	constructor(
		public readonly provider: SearchProviderId,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "SearchProviderError";
	}
}
