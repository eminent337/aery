import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@aryee337/aery-ai";
import { hookFetch } from "@aryee337/aery-utils";
import type { SearchParams } from "../../src/web/search/providers/base";
import { ParallelProvider } from "../../src/web/search/providers/parallel";

const fakeAuthStorage = {
	async getApiKey() {
		return undefined;
	},
	hasAuth() {
		return false;
	},
} as unknown as AuthStorage;

function makeSearchParams(overrides: Partial<SearchParams> = {}): SearchParams {
	return {
		query: "test query",
		systemPrompt: "You are a helpful assistant.",
		authStorage: fakeAuthStorage,
		...overrides,
	};
}

function makeMcpResponse(text: string): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{ type: "text", text }],
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("ParallelProvider", () => {
	describe("isAvailable", () => {
		it("always returns true (MCP endpoint works without API key)", () => {
			const provider = new ParallelProvider();
			expect(provider.isAvailable(fakeAuthStorage)).toBe(true);
		});
	});

	describe("search", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("extracts sources from JSON inside MCP text", async () => {
			const jsonText = `{\n  "search_id": "s1",\n  "results": [\n    { "url": "https://x.com", "title": "X", "excerpt": "ex" }\n  ]\n}`;

			using _hook = hookFetch(() => makeMcpResponse(jsonText));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "x" }));

			expect(result.provider).toBe("parallel");
			expect(result.sources).toHaveLength(1);
			expect(result.sources[0]).toMatchObject({
				title: "X",
				url: "https://x.com",
				snippet: "ex",
			});
		});

		it("extracts multiple sources from JSON results", async () => {
			const jsonText = JSON.stringify({
				search_id: "multi",
				results: [
					{ url: "https://a.com", title: "Alpha", excerpt: "first" },
					{ url: "https://b.com", title: "Beta", excerpt: "second" },
					{ url: "https://c.com", title: "Gamma", excerpt: "third" },
				],
			});

			using _hook = hookFetch(() => makeMcpResponse(jsonText));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "multi" }));

			expect(result.sources).toHaveLength(3);
			expect(result.sources.map(s => s.url)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
		});

		it("falls back to markdown/bare-URL extraction when JSON doesn't parse", async () => {
			// Not valid JSON, but has markdown links
			const text = `Check out [the docs](https://docs.example.com) for more.`;

			using _hook = hookFetch(() => makeMcpResponse(text));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "docs" }));

			expect(result.sources).toHaveLength(1);
			expect(result.sources[0]).toMatchObject({
				title: "the docs",
				url: "https://docs.example.com",
			});
		});

		it("falls back to Title:\\nURL: block extraction when JSON doesn't parse", async () => {
			const text = `Title: Example Site
URL: https://example.com
Published: today`;

			using _hook = hookFetch(() => makeMcpResponse(text));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "example" }));

			expect(result.sources).toHaveLength(1);
			expect(result.sources[0]).toMatchObject({
				title: "Example Site",
				url: "https://example.com",
			});
		});

		it("returns empty sources when no URLs exist anywhere", async () => {
			const text = `No search results here. Just some plain text with no links.`;

			using _hook = hookFetch(() => makeMcpResponse(text));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "plain" }));

			expect(result.provider).toBe("parallel");
			expect(result.sources).toHaveLength(0);
		});

		it("uses authStorage.getApiKey when available for Bearer token", async () => {
			const jsonText = JSON.stringify({
				results: [{ url: "https://example.com", title: "Example", excerpt: "test" }],
			});
			let capturedHeaders: Record<string, string> | undefined;

			const authStorageWithKey = {
				async getApiKey(_provider: string, _sessionId?: string) {
					return "my-parallel-key";
				},
				hasAuth() {
					return true;
				},
			} as unknown as AuthStorage;

			using _hook = hookFetch(async (url, init) => {
				if (typeof url === "string" && url.includes("search.parallel.ai")) {
					capturedHeaders = init?.headers as Record<string, string>;
				}
				return makeMcpResponse(jsonText);
			});

			const provider = new ParallelProvider();
			await provider.search(makeSearchParams({ authStorage: authStorageWithKey, query: "test" }));

			expect(capturedHeaders?.Authorization).toBe("Bearer my-parallel-key");
		});

		it("throws on non-ok HTTP response", async () => {
			using _hook = hookFetch(() => new Response("Service Unavailable", { status: 503 }));

			const provider = new ParallelProvider();
			await expect(provider.search(makeSearchParams({ query: "error" }))).rejects.toMatchObject({
				provider: "parallel",
				status: 503,
			});
		});

		it("handles JSON with results but missing url fields gracefully", async () => {
			const jsonText = JSON.stringify({
				results: [
					{ title: "No URL here", excerpt: "test" },
					{ url: "https://valid.com", title: "Has URL", excerpt: "valid" },
				],
			});

			using _hook = hookFetch(() => makeMcpResponse(jsonText));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "filter" }));

			// Only the entry with a valid url should be included
			expect(result.sources).toHaveLength(1);
			expect(result.sources[0].url).toBe("https://valid.com");
		});

		it("returns answer with raw MCP text content", async () => {
			const jsonText = JSON.stringify({ results: [{ url: "https://x.com", title: "X", excerpt: "e" }] });

			using _hook = hookFetch(() => makeMcpResponse(jsonText));

			const provider = new ParallelProvider();
			const result = await provider.search(makeSearchParams({ query: "answer test" }));

			expect(result.answer).toBe(jsonText);
		});
	});
});
