/**
 * Cache Debugging & Correlation Utilities
 *
 * Ported from Freebuff's prompt cache optimization engine.
 * Helps normalize provider request bodies for stable hashing and provides
 * helpers to correlate cache hits across distributed systems.
 */

import { createHash } from "node:crypto";

export interface CacheDebugCorrelation {
	/** Unique identifier for the request */
	requestId: string;
	/** Hash of the system prompt and static tools (prefix) */
	systemHash: string;
	/** Ordered hashes of conversation messages */
	messageHashes: string[];
	/** Estimated cache hit token count */
	expectedCacheReadTokens?: number;
}

/**
 * Truncate long strings for serialization (e.g. large base64 image payloads).
 */
function summarizeLargeValue(value: string, maxLength = 200): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength / 2)}...[${value.length - maxLength} omitted]...${value.slice(-maxLength / 2)}`;
}

/**
 * Specifically targets data URLs like `data:image/png;base64,...`
 */
function summarizeDataUrl(value: string): string {
	if (value.startsWith("data:image/")) {
		const commaIdx = value.indexOf(",");
		if (commaIdx !== -1) {
			const prefix = value.slice(0, commaIdx + 1);
			const payload = value.slice(commaIdx + 1);
			return `${prefix}${summarizeLargeValue(payload, 100)}`;
		}
	}
	return summarizeLargeValue(value);
}

/**
 * Deeply normalizes an object, summarizing large strings and data URLs
 * to ensure stable JSON serialization for hashing without hitting memory limits.
 */
function normalizeForJson(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj === "string") {
		return summarizeDataUrl(obj);
	}
	if (Array.isArray(obj)) {
		return obj.map(normalizeForJson);
	}
	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			// Skip unstable runtime fields that don't affect caching
			if (key === "stream" || key === "stream_options") continue;
			result[key] = normalizeForJson(value);
		}
		return result;
	}
	return obj;
}

/**
 * Normalizes a provider request body (Anthropic, DeepSeek, OpenAI) for cache debugging.
 * Removes stream flags and truncates giant payloads.
 *
 * @param provider The provider ID (e.g., "anthropic", "openai")
 * @param body The parsed JSON request body sent to the provider
 */
export function normalizeProviderRequestBodyForCacheDebug(provider: string, body: unknown): unknown {
	const normalized = normalizeForJson(body);
	if (typeof normalized === "object" && normalized !== null) {
		const rec = normalized as Record<string, unknown>;
		// Remove top-level message arrays to compute just the prefix hash
		// if we only want system/tools. For full body, keep it.
		// Freebuff retains everything but truncates contents.
		return rec;
	}
	return normalized;
}

/**
 * Generates a stable SHA-256 hash for a normalized payload.
 */
export function generateStableHash(payload: unknown): string {
	const text = JSON.stringify(payload);
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Serialize a cache correlation object into a base64 encoded string
 * suitable for inclusion in an HTTP header (e.g. `X-Cache-Correlation`).
 */
export function serializeCacheDebugCorrelation(data: CacheDebugCorrelation): string {
	return Buffer.from(JSON.stringify(data), "utf-8").toString("base64");
}

/**
 * Parse a base64 encoded cache correlation header back into an object.
 */
export function parseCacheDebugCorrelation(headerValue: string): CacheDebugCorrelation | undefined {
	try {
		const json = Buffer.from(headerValue, "base64").toString("utf-8");
		const data = JSON.parse(json);
		if (data && typeof data === "object" && typeof data.requestId === "string") {
			return data as CacheDebugCorrelation;
		}
	} catch {
		// Ignore parsing errors
	}
	return undefined;
}
