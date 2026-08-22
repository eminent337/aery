import { afterEach, describe, expect, test } from "bun:test";
import { kiloModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

// Kilo gateway `/models` response shape (simplified from live API):
// top-level entries carry `context_length`, `top_provider.max_completion_tokens`,
// `isFree`, `supported_parameters`, `pricing`, `architecture`.
const KILO_PAYLOAD = {
	data: [
		{
			id: "meituan/longcat-2.0-free",
			name: "Meituan: LongCat 2.0 (free)",
			object: "model",
			owned_by: "kilo",
			context_length: 1_048_756,
			max_completion_tokens: null,
			isFree: true,
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
			top_provider: { context_length: 1_048_756, max_completion_tokens: 131_072, is_moderated: false },
			supported_parameters: ["max_tokens", "temperature", "tools"],
			pricing: { prompt: "0", completion: "0", request: "0" },
		},
		{
			id: "kilo-auto/frontier",
			name: "Auto Frontier",
			object: "model",
			owned_by: "kilo",
			context_length: 1_000_000,
			max_completion_tokens: 128_000,
			isFree: false,
			architecture: { input_modalities: ["text", "image", "pdf"], output_modalities: ["text"] },
			top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
			supported_parameters: ["max_tokens", "temperature"],
			pricing: { prompt: "-1", completion: "-1", request: "0" },
		},
		// Entry with no numeric limits: must fall back to UNK defaults rather
		// than NaN or a crash.
		{
			id: "meituan/longcat-2.0-free-unknown",
			name: "Unknown limits",
			object: "model",
			owned_by: "kilo",
			isFree: true,
			supported_parameters: ["max_tokens"],
		},
	],
};

afterEach(() => {
	global.fetch = originalFetch;
});

function mockKiloFetch(payload: unknown) {
	global.fetch = (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("kilo model discovery", () => {
	test("maps real context window and max completion tokens from kilo /models", async () => {
		mockKiloFetch(KILO_PAYLOAD);
		const options = kiloModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("kilo");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();

		const longcat = models?.find(m => m.id === "meituan/longcat-2.0-free");
		expect(longcat).toBeDefined();
		expect(longcat?.contextWindow).toBe(1_048_756);
		expect(longcat?.maxTokens).toBe(131_072);

		// Free filter: paid kilo-auto/frontier must be excluded.
		const ids = models?.map(m => m.id) ?? [];
		expect(ids).not.toContain("kilo-auto/frontier");
	});

	test("falls back to UNK defaults when kilo omits numeric limits", async () => {
		mockKiloFetch(KILO_PAYLOAD);
		const options = kiloModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();

		const unknown = models?.find(m => m.id === "meituan/longcat-2.0-free-unknown");
		expect(unknown).toBeDefined();
		// 222_222 / 8_888 are the "unknown" placeholders, not hidden real values.
		expect(unknown?.contextWindow).toBe(222_222);
		expect(unknown?.maxTokens).toBe(8_888);
	});
});
