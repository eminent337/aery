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

	test("fetches dynamic models and filters for free models only", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{ id: "cline-free/claude-sonnet-4.5", name: "Claude Sonnet 4.5 Free", isFree: true },
							{ id: "deepseek-r1-free", name: "DeepSeek R1 Free" },
							{ id: "paid-gpt-5.4", name: "Paid GPT 5.4", isFree: false },
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
			"https://api.cline.bot/api/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		// Paid model paid-gpt-5.4 must be filtered out
		const modelIds = models?.map(m => m.id);
		expect(modelIds).toContain("cline-free/claude-sonnet-4.5");
		expect(modelIds).toContain("deepseek-r1-free");
		expect(modelIds).not.toContain("paid-gpt-5.4");
	});
});
