import { afterEach, describe, expect, test } from "bun:test";
import { opencodeGoModelManagerOptions, opencodeZenModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;
const GO_PAYLOAD = {
	data: [
		{ id: "ox-alpha-free", object: "model", owned_by: "opencode" },
		{ id: "minimax-m3", object: "model", owned_by: "opencode" },
		{ id: "glm-5.3", object: "model", owned_by: "opencode" },
		{ id: "deepseek-v4-flash", object: "model", owned_by: "opencode" },
		{ id: "gpt-5.6-luna", object: "model", owned_by: "opencode" },
		{ id: "kimi-k3", object: "model", owned_by: "opencode" },
	],
};

const ZEN_PAYLOAD = {
	data: [
		{ id: "big-pickle", object: "model", owned_by: "opencode" },
		{ id: "mimo-v2.5-free", object: "model", owned_by: "opencode" },
		{ id: "gpt-5.4", object: "model", owned_by: "opencode" },
		{ id: "ox-alpha-free", object: "model", owned_by: "opencode" },
		{ id: "deepseek-v4-flash-free", object: "model", owned_by: "opencode" },
		{ id: "nemotron-3-ultra-free", object: "model", owned_by: "opencode" },
	],
};

afterEach(() => {
	global.fetch = originalFetch;
});

function mockOpenCodeFetch(payload: unknown) {
	global.fetch = (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("opencode model discovery free-filter", () => {
	test("opencode-go with real key still filters to free models only", async () => {
		mockOpenCodeFetch(GO_PAYLOAD);
		const options = opencodeGoModelManagerOptions({ apiKey: "real-key-123" });
		expect(options.providerId).toBe("opencode-go");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const ids = models?.map(m => m.id) ?? [];
		// Even with a real key, the free filter always applies.
		expect(ids).toContain("ox-alpha-free");
		expect(ids).not.toContain("minimax-m3");
	});

	test("opencode-go free access (no key) keeps only -free models", async () => {
		mockOpenCodeFetch(GO_PAYLOAD);
		// No apiKey → defaults to "public" → free access filter
		const options = opencodeGoModelManagerOptions({});
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const ids = models?.map(m => m.id) ?? [];
		expect(ids).toContain("ox-alpha-free");
		// Paid / non-free models must be filtered out.
		for (const id of ["minimax-m3", "glm-5.3", "deepseek-v4-flash", "gpt-5.6-luna", "kimi-k3"]) {
			expect(ids).not.toContain(id);
		}
	});

	test("opencode-zen free access keeps genuinely free models, excludes blocked -free ids", async () => {
		mockOpenCodeFetch(ZEN_PAYLOAD);
		// No apiKey → defaults to "public" → free access filter
		const options = opencodeZenModelManagerOptions({});
		expect(options.providerId).toBe("opencode-zen");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		const ids = models?.map(m => m.id) ?? [];
		expect(ids).toContain("big-pickle");
		expect(ids).toContain("mimo-v2.5-free");
		expect(ids).toContain("nemotron-3-ultra-free");
		expect(ids).not.toContain("gpt-5.4");
		// deepseek-v4-flash-free carries a "-free" suffix but the zen gateway
		// rejects it anonymously (HTTP 400 "Model is unavailable"), so it must
		// NOT surface in the free list (this is the 7-vs-8 discrepancy).
		expect(ids).not.toContain("deepseek-v4-flash-free");
	});

	test("opencode-zen with real key still filters to free models only", async () => {
		mockOpenCodeFetch(ZEN_PAYLOAD);
		const options = opencodeZenModelManagerOptions({ apiKey: "zen-key-456" });
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		const ids = models?.map(m => m.id) ?? [];
		expect(ids).toContain("big-pickle");
		expect(ids).toContain("mimo-v2.5-free");
		// Paid models must be excluded even with a real key.
		expect(ids).not.toContain("gpt-5.4");
		// deepseek-v4-flash-free stays excluded (blocked anonymously).
		expect(ids).not.toContain("deepseek-v4-flash-free");
	});

	test("default apiKey is 'public' matching opencode CLI behavior", () => {
		// Both providers should always have fetchDynamicModels defined
		// (unlike before where no apiKey meant no discovery)
		const zen = opencodeZenModelManagerOptions();
		expect(zen.fetchDynamicModels).toBeDefined();

		const go = opencodeGoModelManagerOptions();
		expect(go.fetchDynamicModels).toBeDefined();
	});
});

describe("opencode runtime api resolution from models.dev npm metadata", () => {
	const MODELS_DEV_PAYLOAD = {
		opencode: {
			models: {
				"big-pickle": {
					id: "big-pickle",
					tool_call: true,
				},
				"muse-spark-1.2-contributor-free": {
					id: "muse-spark-1.2-contributor-free",
					tool_call: true,
					provider: { npm: "@ai-sdk/openai" },
				},
			},
		},
	};

	function mockUrlAwareFetch(payloads: { modelsDev?: unknown; models?: unknown }) {
		global.fetch = (async (url: string | URL | Request) => {
			const text = String(url);
			if (text.includes("models.dev")) {
				return new Response(JSON.stringify(payloads.modelsDev ?? { error: "unexpected" }), {
					status: payloads.modelsDev ? 200 : 500,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(payloads.models), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	}

	test("muse-spark routes to openai-responses with correct baseUrl, others stay chat", async () => {
		mockUrlAwareFetch({
			modelsDev: MODELS_DEV_PAYLOAD,
			models: {
				data: [
					{ id: "big-pickle", object: "model", owned_by: "opencode" },
					{ id: "muse-spark-1.2-contributor-free", object: "model", owned_by: "opencode" },
				],
			},
		});
		const options = opencodeZenModelManagerOptions({ baseUrl: "https://opencode.ai/zen" });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map(models?.map(m => [m.id, m]) ?? []);

		// muse-spark is served via the OpenAI Responses API per models.dev npm
		// metadata; the discovered catalog alone would route it through
		// chat/completions, which the gateway 500s on.
		const muse = byId.get("muse-spark-1.2-contributor-free");
		expect(muse).toBeDefined();
		expect(muse?.api).toBe("openai-responses");
		expect(muse?.baseUrl).toBe("https://opencode.ai/zen/v1");

		// big-pickle has a models.dev entry without npm metadata → default stays.
		const bigPickle = byId.get("big-pickle");
		expect(bigPickle).toBeDefined();
		expect(bigPickle?.api).toBe("openai-completions");
		expect(bigPickle?.baseUrl).toBe("https://opencode.ai/zen/v1");
	});

	test("models.dev failure degrades gracefully: all models keep default routing", async () => {
		mockUrlAwareFetch({
			models: {
				data: [{ id: "muse-spark-1.2-contributor-free", object: "model", owned_by: "opencode" }],
			},
		});
		const options = opencodeZenModelManagerOptions({});
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const muse = models?.find(m => m.id === "muse-spark-1.2-contributor-free");
		expect(muse).toBeDefined();
		expect(muse?.api).toBe("openai-completions");
		expect(muse?.baseUrl).toBe("https://opencode.ai/zen/v1");
	});

	test("anthropic npm model routes to anthropic-messages with bare basePath", async () => {
		mockUrlAwareFetch({
			modelsDev: {
				opencode: {
					models: {
						"nemotron-claude-free": {
							id: "nemotron-claude-free",
							tool_call: true,
							provider: { npm: "@ai-sdk/anthropic" },
						},
					},
				},
			},
			models: {
				data: [{ id: "nemotron-claude-free", object: "model", owned_by: "opencode" }],
			},
		});
		const options = opencodeZenModelManagerOptions({ baseUrl: "https://opencode.ai/zen" });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const claude = models?.find(m => m.id === "nemotron-claude-free");
		expect(claude).toBeDefined();
		expect(claude?.api).toBe("anthropic-messages");
		// anthropic-messages posts to `${baseUrl}/v1/messages`, so baseUrl must
		// be the bare basePath (no /v1 suffix).
		expect(claude?.baseUrl).toBe("https://opencode.ai/zen");
	});
});
