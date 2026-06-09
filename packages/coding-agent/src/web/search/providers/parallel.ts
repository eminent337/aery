/**
 * Parallel Web Search Provider — MCP transport
 *
 * Uses the hosted MCP endpoint (https://search.parallel.ai/mcp) which works
 * without an API key. If a PARALLEL_API_KEY is available, it's passed as
 * a Bearer Authorization header for higher rate limits.
 *
 * Ported from OpenCode's websearch.ts MCP approach.
 */
import { type AuthStorage, getEnvApiKey } from "@aryee337/aery-ai";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { truncateText } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	classifyProviderHttpError,
	extractMcpSources,
	MCP_MAX_RESPONSE_BYTES,
	parseMcpResponse,
	withHardTimeout,
} from "./utils";

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

/**
 * Call the Parallel MCP endpoint with JSON-RPC 2.0.
 */
async function callParallelMcp(
	query: string,
	sessionId: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const headers: Record<string, string> = {
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		"User-Agent": "aery/1.0",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search",
			arguments: {
				objective: query,
				search_queries: [query],
				session_id: sessionId,
			},
		},
	};

	const response = await fetch(PARALLEL_MCP_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("parallel", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"parallel",
			`Parallel MCP error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MCP_MAX_RESPONSE_BYTES) {
		throw new SearchProviderError("parallel", `Parallel response exceeded ${MCP_MAX_RESPONSE_BYTES} bytes`);
	}

	const result = parseMcpResponse(text);
	if (!result) {
		throw new SearchProviderError("parallel", "Parallel MCP returned no parseable content");
	}

	return result;
}

/** Search provider for Parallel via MCP. */
export class ParallelProvider extends SearchProvider {
	readonly id = "parallel" as const;
	readonly label = "Parallel";

	/**
	 * Parallel MCP works without an API key — the hosted endpoint handles auth.
	 * Always available.
	 */
	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		let apiKey: string | undefined;
		try {
			const stored = params.authStorage
				? await params.authStorage.getApiKey("parallel", params.sessionId, { signal: params.signal })
				: undefined;
			apiKey = stored ?? getEnvApiKey("parallel");
		} catch {
			/* no key available, MCP works without it */
		}

		const sessionId = params.sessionId ?? "aery-session";
		const text = await callParallelMcp(params.query, sessionId, apiKey, params.signal);

		// Try JSON parsing first (Parallel returns structured JSON)
		let sources: SearchSource[] = [];
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed?.results)) {
				sources = parsed.results
					.filter((r: any) => r?.url)
					.map((r: any) => ({
						title: r.title || r.url,
						url: r.url,
						snippet:
							typeof r.excerpt === "string"
								? r.excerpt
								: Array.isArray(r.excerpts)
									? r.excerpts.join("\n\n")
									: undefined,
						publishedDate: r.publish_date || r.publishedDate,
					}));
			}
		} catch {
			/* not JSON, fall through */
		}

		// Fall back to generic extraction if JSON didn't yield sources
		if (sources.length === 0) {
			sources = extractMcpSources(text);
		}

		return { answer: truncateText(text, 2_500), sources, provider: "parallel" };
	}
}
