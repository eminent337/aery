import { expect, test } from "bun:test";
import {
	type CacheDebugCorrelation,
	generateStableHash,
	normalizeProviderRequestBodyForCacheDebug,
	parseCacheDebugCorrelation,
	serializeCacheDebugCorrelation,
} from "../src/utils/cache-debug";

test("summarizeDataUrl truncates large image payloads", () => {
	const body = {
		messages: [
			{
				role: "user",
				content: [{ type: "image", source: { type: "base64", data: `data:image/png;base64,${"A".repeat(500)}` } }],
			},
		],
	};
	const normalized = normalizeProviderRequestBodyForCacheDebug("anthropic", body) as Record<string, unknown>;
	const messages = normalized.messages as Record<string, unknown>[];
	const content = messages[0]?.content as Record<string, unknown>[];
	const source = content[0]?.source as Record<string, string>;

	expect(source.data).toContain("data:image/png;base64,");
	expect(source.data).toContain("omitted");
	expect(source.data.length).toBeLessThan(200); // 100 char limit + prefix/suffix length
});

test("normalizeProviderRequestBodyForCacheDebug drops stream options", () => {
	const body = {
		model: "claude-3-5-sonnet",
		stream: true,
		stream_options: { include_usage: true },
		messages: [{ role: "user", content: "hello" }],
	};
	const normalized = normalizeProviderRequestBodyForCacheDebug("anthropic", body) as Record<string, unknown>;
	expect(normalized.stream).toBeUndefined();
	expect(normalized.stream_options).toBeUndefined();
	expect(normalized.model).toBe("claude-3-5-sonnet");
	expect(normalized.messages).toBeDefined();
});

test("generateStableHash returns consistent hex digest", () => {
	const payload1 = { a: 1, b: "test" };
	const payload2 = { a: 1, b: "test" };
	expect(generateStableHash(payload1)).toBe(generateStableHash(payload2));
});

test("cache correlation serialization round-trips correctly", () => {
	const data: CacheDebugCorrelation = {
		requestId: "req-123",
		systemHash: "hash-sys",
		messageHashes: ["hash-1", "hash-2"],
		expectedCacheReadTokens: 1024,
	};
	const header = serializeCacheDebugCorrelation(data);
	const parsed = parseCacheDebugCorrelation(header);
	expect(parsed).toMatchObject(data);
});

test("parseCacheDebugCorrelation handles invalid data safely", () => {
	expect(parseCacheDebugCorrelation("not-base64!")).toBeUndefined();
	expect(parseCacheDebugCorrelation(Buffer.from("invalid json").toString("base64"))).toBeUndefined();
	expect(
		parseCacheDebugCorrelation(Buffer.from(JSON.stringify({ wrong: "shape" })).toString("base64")),
	).toBeUndefined();
});
