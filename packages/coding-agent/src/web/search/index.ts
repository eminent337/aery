/**
 * Unified Web Search Tool — 4-tier cascade
 *
 * Cascade order: tavily → exa → parallel → ddg
 * Falls through on error, empty results, or 202 (rate-limited success).
 * Each provider gets 25s hard timeout.
 */

import type { AuthStorage } from "@aryee337/aery-ai";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import { prompt } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import { executeCascade } from "./execute-cascade";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "./render";
import type { SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";
import { formatAge, formatCount, MAX_SEARCH_ANSWER_CHARS, truncateText } from "./utils";

/** Web search tool parameters schema */
export const webSearchSchema = z.object({
	query: z.string().describe("search query"),
	recency: z.enum(["day", "week", "month", "year"]).describe("recency filter").optional(),
	limit: z.number().describe("max results").optional(),
	max_tokens: z.number().describe("max output tokens").optional(),
	temperature: z.number().describe("sampling temperature").optional(),
	num_search_results: z.number().describe("number of search results").optional(),
});

export type SearchToolParams = z.infer<typeof webSearchSchema>;

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

/** Format response for LLM consumption */
function formatForLLM(response: SearchResponse): string {
	const parts: string[] = [];

	if (response.answer) {
		parts.push(truncateText(response.answer, MAX_SEARCH_ANSWER_CHARS));
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncateText(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncateText(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncateText(query, 120)}`);
		}
	}

	return parts.join("\n");
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
}

/** Execute web search via 4-tier cascade */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const { authStorage, sessionId, signal } = options;

	try {
		const response = await executeCascade(params, authStorage, sessionId, { provider: params.provider, signal });

		const text = formatForLLM(response);

		return {
			content: [{ type: "text" as const, text }],
			details: { response },
		};
	} catch (error) {
		throwIfAborted(signal);

		let message: string;
		if (error instanceof SearchProviderError) {
			message = error.message;
		} else if (error instanceof Error) {
			message = error.message;
		} else {
			message = String(error);
		}

		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none" as any, sources: [] }, error: message },
		};
	}
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `AERY_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: { authStorage?: AuthStorage; sessionId?: string; signal?: AbortSignal } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const authStorage = options.authStorage ?? (await discoverAuthStorage());
	return executeSearch("cli-web-search", params, {
		authStorage,
		sessionId: options.sessionId,
		signal: options.signal,
	});
}

/**
 * Web search tool implementation.
 *
 * Supports Tavily, Exa, Parallel, and DuckDuckGo providers with 4-tier cascading fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(webSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, { authStorage, sessionId, signal });
	}
}

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, { authStorage, sessionId, signal });
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme) {
		return renderSearchResult(result, options, theme);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider, setPreferredSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isSearchProviderPreference } from "./types";
