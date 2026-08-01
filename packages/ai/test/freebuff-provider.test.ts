import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { freebuffModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

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
		expect(staticIds).toContain("z-ai/glm-5.2");
		expect(staticIds).toContain("poolside/laguna-s-2.1");
	});
});
