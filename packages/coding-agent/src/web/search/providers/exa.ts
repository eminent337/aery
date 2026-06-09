/**
 * Exa Web Search Provider — MCP transport
 *
 * Uses the hosted MCP endpoint (https://mcp.exa.ai/mcp) which works
 * without an API key. If an EXA_API_KEY is available, it's passed as
 * a URL query parameter for higher rate limits.
 *
 * Ported from OpenCode's websearch.ts MCP approach.
 */
import { type AuthStorage, getEnvApiKey } from "@aryee337/aery-ai";
import type { SearchResponse } from "../types";
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

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

/**
 * Build the Exa MCP URL, appending the API key as a query param if available.
 */
function buildExaUrl(apiKey?: string): string {
	if (!apiKey) return EXA_MCP_URL;
	const url = new URL(EXA_MCP_URL);
	url.searchParams.set("exaApiKey", apiKey);
	return url.toString();
}

/**
 * Call the Exa MCP endpoint with JSON-RPC 2.0.
 */
async function callExaMcp(url: string, query: string, numResults: number, signal?: AbortSignal): Promise<string> {
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search_exa",
			arguments: {
				query,
				type: "auto",
				numResults,
				livecrawl: "fallback",
			},
		},
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("exa", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("exa", `Exa MCP error (${response.status}): ${errorText}`, response.status);
	}

	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MCP_MAX_RESPONSE_BYTES) {
		throw new SearchProviderError("exa", `Exa response exceeded ${MCP_MAX_RESPONSE_BYTES} bytes`);
	}

	const result = parseMcpResponse(text);
	if (!result) {
		throw new SearchProviderError("exa", "Exa MCP returned no parseable content");
	}

	return result;
}

/** Search provider for Exa via MCP. */
export class ExaProvider extends SearchProvider {
	readonly id = "exa" as const;
	readonly label = "Exa";

	/**
	 * Exa MCP works without an API key — the hosted endpoint handles auth.
	 * Always available.
	 */
	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		const numResults = params.numSearchResults ?? params.limit ?? 8;

		// Try to get an API key for higher rate limits, but don't require it
		let apiKey: string | undefined;
		try {
			const stored = params.authStorage
				? await params.authStorage.getApiKey("exa", params.sessionId, { signal: params.signal })
				: undefined;
			apiKey = stored ?? getEnvApiKey("exa");
		} catch {
			/* no key available, MCP works without it */
		}

		const url = buildExaUrl(apiKey);
		const text = await callExaMcp(url, params.query, numResults, params.signal);

		// Try extractMcpSources first (handles URL: blocks, JSON, markdown, bare URLs)
		const sources = extractMcpSources(text);

		// If still empty, try structured "Title:\nURL:" block parsing
		if (sources.length === 0) {
			const blockRegex = /Title:\s*([^\n]+)\nURL:\s*([^\n]+)/g;
			let match: RegExpExecArray | null;
			while ((match = blockRegex.exec(text)) !== null) {
				const title = match[1].trim();
				const blockUrl = match[2].trim();
				if (!sources.some(s => s.url === blockUrl)) {
					sources.push({ title, url: blockUrl });
				}
			}
		}

		return { answer: truncateText(text, 2_500), sources, provider: "exa" };
	}
}
