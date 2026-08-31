import { afterEach, describe, expect, it } from "bun:test";
import { Effort } from "../src/model-thinking";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";
import { createOpenCodeChatHeaders } from "../src/utils/oauth/github-copilot";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(): Response {
	const chunk = {
		id: "chatcmpl-zen-ua",
		object: "chat.completion.chunk",
		created: 0,
		model: "mimo-v2.5-free",
		choices: [{ index: 0, delta: { content: "ok" } }],
	};
	const payload = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createZenChatModel(provider: "opencode-zen" | "opencode-go"): Model<"openai-completions"> {
	return {
		id: "mimo-v2.5-free",
		name: "MiMo V2.5 Free",
		api: "openai-completions",
		provider,
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

/**
 * The opencode zen gateway only grants free-tier chat/completions requests the
 * full per-model daily quota when the User-Agent identifies an opencode
 * client; unattributed requests land in a small fallback bucket and 429 with
 * FreeUsageLimitError. Regression test: opencode-zen / opencode-go chat
 * requests must carry the opencode attribution headers
 * (createOpenCodeChatHeaders), mirroring the opencode CLI.
 */
describe("opencode-zen chat request attribution headers", () => {
	it("sends opencode UA and x-opencode-client on opencode-zen chat requests", async () => {
		let captured: Record<string, string> | undefined;
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				captured =
					init?.headers instanceof Headers
						? Object.fromEntries(init.headers.entries())
						: ((init?.headers ?? {}) as Record<string, string>);
				return createSseResponse();
			},
			{ preconnect: originalFetch.preconnect },
		) as unknown as typeof fetch;

		const stream = streamOpenAICompletions(createZenChatModel("opencode-zen"), testContext, {
			apiKey: "public",
		});
		await stream.result();

		expect(captured).toBeDefined();
		const userAgent = captured?.["user-agent"] ?? captured?.["User-Agent"];
		expect(userAgent).toContain("opencode/");
		expect(userAgent).toContain("Aery/");
		expect(captured?.["x-opencode-client"]).toBe("opencode");
	});

	it("does not stamp opencode headers onto other providers' chat requests", async () => {
		let captured: Record<string, string> | undefined;
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				captured =
					init?.headers instanceof Headers
						? Object.fromEntries(init.headers.entries())
						: ((init?.headers ?? {}) as Record<string, string>);
				return createSseResponse();
			},
			{ preconnect: originalFetch.preconnect },
		) as unknown as typeof fetch;

		const stream = streamOpenAICompletions(createZenChatModel("opencode-zen"), testContext, {
			apiKey: "public",
		});
		await stream.result();
		// sanity: same capture mechanics see the opencode headers above; here
		// assert a non-opencode provider does NOT receive them
		const customModel: Model<"openai-completions"> = {
			...createZenChatModel("opencode-zen"),
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
		};
		let customCaptured: Record<string, string> | undefined;
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				customCaptured =
					init?.headers instanceof Headers
						? Object.fromEntries(init.headers.entries())
						: ((init?.headers ?? {}) as Record<string, string>);
				return createSseResponse();
			},
			{ preconnect: originalFetch.preconnect },
		) as unknown as typeof fetch;
		const customStream = streamOpenAICompletions(customModel, testContext, { apiKey: "public" });
		await customStream.result();
		expect(customCaptured?.["x-opencode-client"]).toBeUndefined();
		expect(captured).toBeDefined();
	});

	it("createOpenCodeChatHeaders appends aery identity and optional identifiers", () => {
		const headers = createOpenCodeChatHeaders({ sessionId: "sess-1", requestId: "req-1" });
		expect(headers["User-Agent"]).toContain("opencode/");
		expect(headers["User-Agent"]).toContain("Aery/");
		expect(headers["x-opencode-client"]).toBe("opencode");
		expect(headers["x-opencode-session"]).toBe("sess-1");
		expect(headers["x-opencode-request"]).toBe("req-1");

		const bare = createOpenCodeChatHeaders();
		expect(bare["x-opencode-session"]).toBeUndefined();
		expect(bare["x-opencode-request"]).toBeUndefined();
	});
});
