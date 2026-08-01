import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { freebuffModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";
import { createFreebuffFetch } from "../src/utils/oauth/freebuff";

const originalFreebuffApiKey = Bun.env.FREEBUFF_API_KEY;
const originalCodebuffApiKey = Bun.env.CODEBUFF_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalFreebuffApiKey === undefined) {
		delete Bun.env.FREEBUFF_API_KEY;
	} else {
		Bun.env.FREEBUFF_API_KEY = originalFreebuffApiKey;
	}
	if (originalCodebuffApiKey === undefined) {
		delete Bun.env.CODEBUFF_API_KEY;
	} else {
		Bun.env.CODEBUFF_API_KEY = originalCodebuffApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("freebuff provider support", () => {
	test("resolves FREEBUFF_API_KEY and CODEBUFF_API_KEY from environment", () => {
		Bun.env.FREEBUFF_API_KEY = "freebuff-test-key";
		expect(getEnvApiKey("freebuff")).toBe("freebuff-test-key");

		delete Bun.env.FREEBUFF_API_KEY;
		Bun.env.CODEBUFF_API_KEY = "codebuff-test-key";
		expect(getEnvApiKey("freebuff")).toBe("codebuff-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "freebuff");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek/deepseek-v4-flash");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("FREEBUFF_API_KEY");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("CODEBUFF_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.freebuff).toBe("deepseek/deepseek-v4-flash");
	});

	test("registers Freebuff in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "freebuff");
		expect(provider?.name).toBe("Freebuff (Codebuff)");
	});

	test("returns static models for unauthenticated freebuff provider", async () => {
		const options = freebuffModelManagerOptions();
		expect(options.providerId).toBe("freebuff");
		expect(options.staticModels).toBeDefined();
		const staticIds = options.staticModels?.map(m => m.id);
		expect(staticIds).toContain("deepseek/deepseek-v4-flash");
		expect(staticIds).toContain("deepseek/deepseek-v4-pro");
		expect(staticIds).toContain("minimax/minimax-m3");
		expect(staticIds).toContain("openai/gpt-5.6-luna");
		expect(staticIds).toContain("mimo/mimo-v2.5-pro");
		expect(staticIds).toContain("mimo/mimo-v2.5");
		expect(staticIds).not.toContain("z-ai/glm-5.2");
		expect(staticIds).not.toContain("poolside/laguna-s-2.1");
	});
	test("auto-syncs models from the freebuff session endpoint when authenticated", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						rateLimitsByModel: {
							"deepseek/deepseek-v4-flash": { model: "deepseek/deepseek-v4-flash" },
							"mimo/mimo-v2.5": { model: "mimo/mimo-v2.5" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const options = freebuffModelManagerOptions({ apiKey: "freebuff-test-key" });
		const models = await options.fetchDynamicModels?.();
		expect(models).toBeDefined();
		const ids = models?.map(m => m.id);
		expect(ids).toEqual(["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"]);
	});
	test("createFreebuffFetch preserves Headers-instance auth and injects run_id", async () => {
		// The OpenAI SDK passes a `Headers` instance (not a plain object) in
		// `init.headers`. Spreading it with `{...init.headers}` yields `{}` and
		// silently drops Authorization/Content-Type — a 401. Regression test.
		const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
		global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = String(input);
			const headers =
				init?.headers instanceof Headers
					? Object.fromEntries(init.headers.entries())
					: ((init?.headers ?? {}) as Record<string, string>);
			calls.push({ url, headers, body: String(init?.body ?? "") });
			if (url.includes("/agent-runs")) {
				return new Response(JSON.stringify({ runId: "run-123" }), { status: 200 });
			}
			return new Response(JSON.stringify({ choices: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		const fbFetch = createFreebuffFetch({ apiKey: "fb-key", baseUrl: "https://www.codebuff.com/api/v1" });
		const authHeaders = new Headers({ Authorization: "Bearer fb-key", "Content-Type": "application/json" });
		const res = await fbFetch("https://www.codebuff.com/api/v1/chat/completions", {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [] }),
		});
		expect(res.status).toBe(200);
		const chatCall = calls.find(c => c.url.includes("/chat/completions"));
		expect(chatCall).toBeDefined();
		const lowerHeaders = Object.fromEntries(
			Object.entries(chatCall?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		expect(lowerHeaders.authorization).toBe("Bearer fb-key");
		expect(lowerHeaders["content-type"]).toBe("application/json");
		const body = JSON.parse(chatCall?.body ?? "{}") as { codebuff_metadata?: { run_id?: string } };
		expect(body.codebuff_metadata?.run_id).toBe("run-123");
	});
});
