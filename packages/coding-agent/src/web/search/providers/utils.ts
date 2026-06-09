import type { AgentStorage } from "../../../session/agent-storage";
import {
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
	type SearchSource,
} from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * The caller MUST supply an open {@link AgentStorage} handle so the helper
 * never reaches out to global filesystem state; both the unified web_search
 * chain and one-shot CLI calls open storage exactly once and thread it
 * through every provider.
 *
 * @param storage - Open agent storage handle
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export function findCredential(
	storage: AgentStorage | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!storage) return null;

	try {
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Default hard ceiling for a single web-search round-trip. 60s tolerates
 * legitimate slow LLM-mediated responses while still guaranteeing the session unfreezes
 * within a minute if Bun's `AbortSignal` fails to propagate on Windows.
 *
 * Pure search APIs (tavily, exa, parallel, ddg)
 * settle far faster in practice; reusing the same ceiling keeps the wiring
 * uniform without compromising correctness.
 */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout so an
 * outbound `fetch()` is guaranteed to settle within `ms` even when the
 * runtime fails to propagate cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Max response body size for MCP endpoints. */
export const MCP_MAX_RESPONSE_BYTES = 256 * 1024;

/** MCP JSON-RPC 2.0 response shape. */
interface McpJsonRpcResult {
	result?: {
		content?: Array<{ type: string; text: string }>;
	};
}

/**
 * Parse MCP JSON-RPC response (supports both plain JSON and SSE `data:` lines).
 * Returns the text content from the first content block, or undefined.
 */
export function parseMcpResponse(body: string): string | undefined {
	const trimmed = body.trim();

	// Try direct JSON parse
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as McpJsonRpcResult;
			const text = parsed.result?.content?.find(c => c.text)?.text;
			if (text) return text;
		} catch {
			/* fall through */
		}
	}

	// Try SSE data: lines
	for (const line of trimmed.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		try {
			const parsed = JSON.parse(line.substring(6)) as McpJsonRpcResult;
			const text = parsed.result?.content?.find(c => c.text)?.text;
			if (text) return text;
		} catch {
			/* skip non-JSON lines */
		}
	}

	return undefined;
}

/**
 * Try to extract search results from a JSON search-results payload.
 * Handles shapes like: { "results": [{ "url": "...", "title": "...", "excerpt": "...", "publish_date": "..." }] }
 */
function tryExtractJsonSearchResults(text: string): SearchSource[] | null {
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed?.results)) {
			const results = parsed.results
				.filter((r: any) => r?.url)
				.map((r: any) => ({
					title: r.title || r.url,
					url: r.url,
					snippet:
						typeof r.excerpt === "string"
							? r.excerpt
							: typeof r.excerpts?.[0] === "string"
								? r.excerpts.join("\n\n")
								: undefined,
					publishedDate: r.publish_date || r.publishedDate,
				}));
			if (results.length > 0) return results;
		}
	} catch {
		/* not JSON */
	}
	return null;
}

/**
 * Extract URLs and titles from MCP text that uses "Title: ...\nURL: ..." blocks (Exa format).
 */
function extractUrlLabelBlocks(text: string): SearchSource[] {
	const sources: SearchSource[] = [];
	const urlLabelRegex = /^\s*URL:\s*(https?:\/\/[^\s]+)/gm;
	let match: RegExpExecArray | null;

	while ((match = urlLabelRegex.exec(text)) !== null) {
		const url = match[1];
		if (sources.some(s => s.url === url)) continue;

		// Try to find the preceding Title: line (last one closest to the URL)
		const beforeUrl = text.substring(0, match.index);
		const lastTitleIdx = beforeUrl.lastIndexOf("Title:");
		const title =
			lastTitleIdx !== -1
				? beforeUrl
						.slice(lastTitleIdx + 6)
						.split("\n")[0]
						?.trim() || url
				: url;
		sources.push({ title, url });
	}

	return sources;
}

/**
 * Extract URLs and titles from MCP markdown text into SearchSources.
 * Handles:
 * 1. JSON search-results payloads: { "results": [{ "url": "...", "title": "..." }] }
 * 2. "Title: ...\nURL: ..." blocks (Exa MCP format)
 * 3. Markdown links: [title](url)
 * 4. Bare URLs at line start
 */
export function extractMcpSources(text: string): SearchSource[] {
	// 1. Try JSON search-results first (Parallel format)
	const json = tryExtractJsonSearchResults(text);
	if (json) return json;

	// 2. Try URL: label blocks (Exa format)
	const urlLabelSources = extractUrlLabelBlocks(text);
	if (urlLabelSources.length > 0) return urlLabelSources;

	// 3. Fall back to markdown links and bare URLs
	const sources: SearchSource[] = [];
	const urlRegex = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
	const plainUrlRegex = /(?:^|\n)\s*(https?:\/\/[^\s]+)/gm;
	let match: RegExpExecArray | null;

	while ((match = urlRegex.exec(text)) !== null) {
		const title = match[1]?.trim() || match[2];
		const url = match[2];
		if (title && url && !sources.some(s => s.url === url)) {
			sources.push({ title, url });
		}
	}

	while ((match = plainUrlRegex.exec(text)) !== null) {
		const url = match[1];
		if (url && !sources.some(s => s.url === url)) {
			sources.push({ title: url, url });
		}
	}

	return sources;
}

/**
 * Build a SearchResponse from raw MCP text content.
 * Used by MCP-backed providers (Exa, Parallel).
 */
export function mcpTextToSearchResponse(text: string, provider: SearchProviderId): SearchResponse {
	return {
		answer: text,
		sources: extractMcpSources(text),
		provider,
	};
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}

/**
 * Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users
 * hitting credit-exhaustion and 401/402/403 responses that were surfaced as
 * raw HTTP error text. Map those into compact, provider-tagged messages so
 * the orchestrator can chain-advance cleanly and the final summary stays
 * legible when every provider rejects the request.
 *
 * Returns `null` when the response does not match a known quota/auth signal,
 * leaving the caller to throw its provider-specific fallback error.
 */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}
