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
		{ id: "deepseek-v4-flash-free", object: "model", owned_by: "opencode" },
		{ id: "mimo-v2.5-free", object: "model", owned_by: "opencode" },
		{ id: "gpt-5.4", object: "model", owned_by: "opencode" },
		{ id: "ox-alpha-free", object: "model", owned_by: "opencode" },
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
	test("opencode-go keeps only -free model ids, exposing ox-alpha-free", async () => {
		mockOpenCodeFetch(GO_PAYLOAD);
		const options = opencodeGoModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("opencode-go");
		expect(options.dynamicModelsAuthoritative).toBe(true);
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

	test("opencode-zen keeps -free models and the big-pickle alias", async () => {
		mockOpenCodeFetch(ZEN_PAYLOAD);
		const options = opencodeZenModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("opencode-zen");

		const models = await options.fetchDynamicModels?.();
		const ids = models?.map(m => m.id) ?? [];
		expect(ids).toContain("big-pickle");
		expect(ids).toContain("deepseek-v4-flash-free");
		expect(ids).toContain("mimo-v2.5-free");
		expect(ids).not.toContain("gpt-5.4");
	});

	test("no apiKey means no dynamic fetch (static catalog fallback)", () => {
		const options = opencodeGoModelManagerOptions({});
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
