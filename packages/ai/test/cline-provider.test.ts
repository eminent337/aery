import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { clineModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalClineApiKey = Bun.env.CLINE_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalClineApiKey === undefined) {
		delete Bun.env.CLINE_API_KEY;
	} else {
		Bun.env.CLINE_API_KEY = originalClineApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("cline provider support & free model filtering", () => {
	test("resolves CLINE_API_KEY from environment", () => {
		Bun.env.CLINE_API_KEY = "cline-test-key";
		expect(getEnvApiKey("cline")).toBe("cline-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "cline");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("anthropic/claude-sonnet-4.6");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("CLINE_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.cline).toBe("anthropic/claude-sonnet-4.6");
	});

	test("registers Cline in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "cline");
		expect(provider?.name).toBe("Cline");
	});

	test("fetches free models from the public recommended-models endpoint", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						recommended: [{ id: "anthropic/claude-opus-5", name: "claude-opus-5" }],
						free: [
							{ id: "deepseek/deepseek-v4-flash", name: "deepseek-v4-flash" },
							{ id: "cline-free/glm-5.2", name: "cline-free/glm-5.2" },
							{ id: "poolside/laguna-s-2.1:free", name: "laguna-s-2.1:free" },
							{ id: "stepfun/step-3.7-flash", name: "step-3.7-flash" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const options = clineModelManagerOptions({ apiKey: "cline-test-key" });
		expect(options.providerId).toBe("cline");
		expect(options.fetchDynamicModels).toBeDefined();
		const models = await options.fetchDynamicModels?.();
		expect(models).toBeDefined();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.cline.bot/api/v1/ai/cline/recommended-models",
			expect.objectContaining({ method: "GET" }),
		);
		const modelIds = models?.map(m => m.id);
		expect(modelIds).toEqual([
			"cline-free/glm-5.2",
			"deepseek/deepseek-v4-flash",
			"poolside/laguna-s-2.1:free",
			"stepfun/step-3.7-flash",
		]);
	});
});
