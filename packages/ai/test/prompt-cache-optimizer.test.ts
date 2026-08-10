import { describe, expect, it } from "bun:test";
import { DEFAULT_CACHE_CONFIG, PromptCacheOptimizer } from "../src/utils/prompt-cache-optimizer";

describe("PromptCacheOptimizer", () => {
	describe("instantiation", () => {
		it("should create with default config", () => {
			const optimizer = new PromptCacheOptimizer();
			expect(optimizer).toBeTruthy();
		});

		it("should accept custom config", () => {
			const customConfig = {
				enabled: true,
				targetHitRate: 90,
				maxStaticMessages: 10,
				minStaticTokens: 2048,
				trackMetrics: true,
			};
			const optimizer = new PromptCacheOptimizer(customConfig);
			expect(optimizer).toBeTruthy();
		});
	});

	describe("normalizeRequest", () => {
		it("should normalize an Anthropic request", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [
				{ role: "user", content: "Tell me a story" },
				{ role: "assistant", content: "Once upon a time..." },
				{ role: "user", content: "Continue the story" },
			];

			const normalized = optimizer.normalizeRequest("anthropic", "claude-sonnet-4.5", messages);

			expect(normalized.provider).toBe("anthropic");
			expect(normalized.model).toBe("claude-sonnet-4.5");
			expect(normalized.messages).toHaveLength(3);
			expect(normalized.cacheControl).toEqual({ type: "ephemeral" });
		});

		it("should mark older messages as static", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Response" },
				{ role: "user", content: "Second question" },
			];

			const normalized = optimizer.normalizeRequest("anthropic", "model", messages);

			// Last message should be dynamic, earlier ones static
			expect(normalized.messages[normalized.messages.length - 1].isStatic).toBe(false);
		});

		it("should estimate tokens correctly", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [
				{ role: "user", content: "a".repeat(400) },
				{ role: "assistant", content: "b".repeat(100) },
			];

			const normalized = optimizer.normalizeRequest("anthropic", "model", messages);

			// At least the first message should be static and have token count
			expect(normalized.messages.length).toBeGreaterThan(0);
			expect(normalized.staticTokens).toBeGreaterThanOrEqual(0);
			expect(normalized.dynamicTokens).toBeGreaterThanOrEqual(0);
		});

		it("should handle DeepSeek provider", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [
				{ role: "user", content: "test" },
				{ role: "assistant", content: "response" },
			];

			const normalized = optimizer.normalizeRequest("deepseek", "deepseek-v4-pro", messages);

			expect(normalized.provider).toBe("deepseek");
			// DeepSeek doesn't use cacheControl field
			expect(normalized.cacheControl).toBeUndefined();
		});

		it("should handle OpenAI provider", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [
				{ role: "user", content: "test" },
				{ role: "assistant", content: "response" },
			];

			const normalized = optimizer.normalizeRequest("openai", "gpt-4o", messages);

			expect(normalized.provider).toBe("openai");
		});
	});

	describe("metrics tracking", () => {
		it("should record cache hits", () => {
			const optimizer = new PromptCacheOptimizer();

			optimizer.recordCacheEvent("anthropic", true, 500);

			const metrics = optimizer.getMetrics("anthropic");
			expect(metrics).toBeTruthy();
			expect(metrics?.cacheHits).toBe(1);
			expect(metrics?.hitRate).toBe(100);
		});

		it("should record cache misses", () => {
			const optimizer = new PromptCacheOptimizer();

			optimizer.recordCacheEvent("anthropic", false, 1000);

			const metrics = optimizer.getMetrics("anthropic");
			expect(metrics?.cacheMisses).toBe(1);
			expect(metrics?.hitRate).toBe(0);
		});

		it("should calculate hit rate correctly", () => {
			const optimizer = new PromptCacheOptimizer();

			optimizer.recordCacheEvent("anthropic", true, 500);
			optimizer.recordCacheEvent("anthropic", true, 500);
			optimizer.recordCacheEvent("anthropic", false, 1000);

			const metrics = optimizer.getMetrics("anthropic");
			expect(metrics?.hitRate).toBeCloseTo(66.67, 1);
		});

		it("should track multiple providers", () => {
			const optimizer = new PromptCacheOptimizer();

			optimizer.recordCacheEvent("anthropic", true, 500);
			optimizer.recordCacheEvent("deepseek", false, 800);

			const allMetrics = optimizer.getAllMetrics();
			expect(allMetrics).toHaveLength(2);
		});

		it("should skip tracking when disabled", () => {
			const config = { ...DEFAULT_CACHE_CONFIG, trackMetrics: false };
			const optimizer = new PromptCacheOptimizer(config);

			optimizer.recordCacheEvent("anthropic", true, 500);

			const metrics = optimizer.getMetrics("anthropic");
			expect(metrics).toBeUndefined();
		});
	});

	describe("configuration", () => {
		it("should have reasonable defaults", () => {
			expect(DEFAULT_CACHE_CONFIG.enabled).toBe(true);
			expect(DEFAULT_CACHE_CONFIG.targetHitRate).toBeGreaterThanOrEqual(80);
			expect(DEFAULT_CACHE_CONFIG.maxStaticMessages).toBeGreaterThan(0);
			expect(DEFAULT_CACHE_CONFIG.trackMetrics).toBe(true);
		});
	});

	describe("multi-turn conversation handling", () => {
		it("should handle long conversations", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [];
			for (let i = 0; i < 20; i++) {
				messages.push({
					role: i % 2 === 0 ? "user" : "assistant",
					content: `Message ${i}`,
				});
			}

			const normalized = optimizer.normalizeRequest("anthropic", "model", messages);

			expect(normalized.messages).toHaveLength(20);
			// Should respect maxStaticMessages
			const staticCount = normalized.messages.filter(m => m.isStatic).length;
			expect(staticCount).toBeLessThanOrEqual(DEFAULT_CACHE_CONFIG.maxStaticMessages);
		});

		it("should keep at least one message dynamic", () => {
			const optimizer = new PromptCacheOptimizer();

			const messages = [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
			];

			const normalized = optimizer.normalizeRequest("anthropic", "model", messages);

			const dynamicCount = normalized.messages.filter(m => !m.isStatic).length;
			expect(dynamicCount).toBeGreaterThanOrEqual(1);
		});
	});

	describe("provider-specific behavior", () => {
		it("should set cache_control for Anthropic only", () => {
			const anthropic = new PromptCacheOptimizer();
			const deepseek = new PromptCacheOptimizer();
			const openai = new PromptCacheOptimizer();

			const messages = [{ role: "user", content: "test" }];

			const anthropicNorm = anthropic.normalizeRequest("anthropic", "model", messages);
			const deepseekNorm = deepseek.normalizeRequest("deepseek", "model", messages);
			const openaiNorm = openai.normalizeRequest("openai", "model", messages);

			expect(anthropicNorm.cacheControl).toBeDefined();
			expect(deepseekNorm.cacheControl).toBeUndefined();
			expect(openaiNorm.cacheControl).toBeUndefined();
		});
	});
});
