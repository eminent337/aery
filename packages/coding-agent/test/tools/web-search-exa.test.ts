import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@aryee337/aery-ai";
import { hookFetch } from "@aryee337/aery-utils";
import type { SearchParams } from "../../src/web/search/providers/base";
import { ExaProvider } from "../../src/web/search/providers/exa";

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

describe("ExaProvider", () => {
	describe("isAvailable", () => {
		it("always returns true (MCP endpoint works without API key)", () => {
			const provider = new ExaProvider();
			expect(provider.isAvailable(fakeAuthStorage)).toBe(true);
		});
	});

	describe("search", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("extracts sources from structured Title:\\nURL: text blocks", async () => {
			const text = `Title: Aether
URL: https://aether.io/
Published: N/A

Title: Aeria
URL: https://aeria.cx/docs`;

			using _hook = hookFetch(() => makeMcpResponse(text));

			const provider = new ExaProvider();
			const result = await provider.search(makeSearchParams({ query: "aether" }));

			expect(result.provider).toBe("exa");
			expect(result.sources).toHaveLength(2);
			expect(result.sources[0]).toMatchObject({
				title: "Aether",
				url: "https://aether.io/",
			});
			expect(result.sources[1]).toMatchObject({
				title: "Aeria",
				url: "https://aeria.cx/docs",
			});
		});

		it("extracts sources from markdown links inside MCP text", async () => {
			const text = `Here are some results:

- [Aether Homepage](https://aether.io/)
- [Aeria Docs](https://aeria.cx/docs)

That's all.`;

			using _hook = hookFetch(() => makeMcpResponse(text));

			const provider = new ExaProvider();
			const result = await provider.search(makeSearchParams({ query: "aether" }));

			expect(result.sources).toHaveLength(2);
			expect(result.sources[0]).toMatchObject({
				title: "Aether Homepage",
				url: "https://aether.io/",
			});
			expect(result.sources[1]).toMatchObject({
				title: "Aeria Docs",
				url: "https://aeria.cx/docs",
			});
		});

		it("returns empty sources when MCP text has no URLs", async () => {
			const text = `No URLs here, just plain text describing some concepts.
Nothing parseable as a link either.`;

			using _hook = hookFetch(() => makeMcpResponse(text));

			const provider = new ExaProvider();
			const result = await provider.search(makeSearchParams({ query: "plain" }));

			expect(result.provider).toBe("exa");
			expect(result.sources).toHaveLength(0);
			expect(result.answer).toBe(text);
		});

		it("uses authStorage.getApiKey when available", async () => {
			const text = `Title: Authed Search\nURL: https://example.com`;
			let capturedUrl: string | URL | Request | undefined;

			const authStorageWithKey = {
				async getApiKey(_provider: string, _sessionId?: string) {
					return "my-exa-key";
				},
				hasAuth() {
					return true;
				},
			} as unknown as AuthStorage;

			using _hook = hookFetch(url => {
				capturedUrl = url;
				return makeMcpResponse(text);
			});

			const provider = new ExaProvider();
			await provider.search(makeSearchParams({ authStorage: authStorageWithKey, query: "authed" }));

			expect(capturedUrl).toContain("exaApiKey=my-exa-key");
		});

		it("throws on non-ok HTTP response", async () => {
			using _hook = hookFetch(() => new Response("Internal Server Error", { status: 500 }));

			const provider = new ExaProvider();
			await expect(provider.search(makeSearchParams({ query: "error" }))).rejects.toMatchObject({
				provider: "exa",
				status: 500,
			});
		});
	});
});
