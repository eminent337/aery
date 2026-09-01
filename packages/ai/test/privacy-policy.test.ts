import { describe, expect, it } from "bun:test";
import {
	__resetPrivacyPolicy,
	getPrivacyPolicy,
	isDataCollectingModel,
	type PrivacyMode,
	resolvePrivacyMode,
	resolvePrivacyTier,
	setPrivacyPolicy,
} from "../src/privacy/policy";

describe("privacy policy: tier resolution", () => {
	it("classifies opencode zen free models as data-collecting", () => {
		for (const id of [
			"muse-spark-1.2-contributor-free",
			"big-pickle",
			"mimo-v2.5-free",
			"ling-3.0-flash-fin-free",
			"nemotron-3-ultra-free",
			"nemotron-3.5-lightning-free",
		]) {
			expect(resolvePrivacyTier(id)).toBe("data-collecting");
			expect(isDataCollectingModel(id)).toBe(true);
		}
	});

	it("treats casing variations consistently", () => {
		expect(resolvePrivacyTier("MUSE-SPARK-1.2-CONTRIBUTOR-FREE")).toBe("data-collecting");
		expect(resolvePrivacyTier("Big-Pickle")).toBe("data-collecting");
	});

	it("classifies every free-tier marker as data-collecting (non-zen)", () => {
		for (const id of [
			"openrouter/free",
			"openai/gpt-oss-20b:free",
			"deepseek/deepseek-v4-flash:free",
			"google/gemma-3-27b-it:free",
			"x-ai/grok-code-fast-1:optimized:free",
			"kilo-auto/free",
			"kilo/auto-free",
			"deepseek-v4-flash-free",
			"google/gemini-3.5-flash-free",
			"glm-5-free",
			"kimi-k2.5-free",
			"xiaomi/mimo-v2-flash-free",
		]) {
			expect(resolvePrivacyTier(id)).toBe("data-collecting");
			expect(isDataCollectingModel(id)).toBe(true);
		}
	});

	it("classifies everything else as zero-retention (incl. non-free aliases)", () => {
		for (const id of [
			"gpt-5",
			"claude-sonnet-4-5",
			"opencode-zen-0.5-preview",
			"ollama/llama3",
			"kimi-k2.5",
			"deepseek/deepseek-v4-flash",
			"openrouter/auto",
			"azure/gpt-4o",
			"deepseek/deepseek-v4-pro",
		]) {
			expect(resolvePrivacyTier(id)).toBe("zero-retention");
			expect(isDataCollectingModel(id)).toBe(false);
		}
	});
});

describe("privacy policy: default mode resolution", () => {
	it("blocks data-collecting models by default", () => {
		expect(resolvePrivacyMode("muse-spark-1.2-contributor-free")).toBe("block");
		expect(resolvePrivacyMode("big-pickle")).toBe("block");
	});
	it("passes through zero-retention models", () => {
		expect(resolvePrivacyMode("gpt-5")).toBe("off");
		expect(resolvePrivacyMode("claude-sonnet-4-5")).toBe("off");
	});
});

describe("privacy policy: injectable provider + extras", () => {
	it("custom policy can downgrade to warn", () => {
		setPrivacyPolicy({
			resolveMode(_modelId, _tier) {
				return "warn" as PrivacyMode;
			},
			extraDataCollecting: new Set<string>(),
		});
		expect(resolvePrivacyMode("muse-spark-1.2-contributor-free")).toBe("warn");
		__resetPrivacyPolicy();
		expect(resolvePrivacyMode("muse-spark-1.2-contributor-free")).toBe("block");
	});
	it("custom policy can fully disable", () => {
		setPrivacyPolicy({
			resolveMode() {
				return "off" as PrivacyMode;
			},
			extraDataCollecting: new Set<string>(),
		});
		expect(resolvePrivacyMode("big-pickle")).toBe("off");
		__resetPrivacyPolicy();
	});
	it("extra ids extend the data-collecting set", () => {
		setPrivacyPolicy({
			resolveMode(_modelId, tier) {
				return tier === "data-collecting" ? "block" : ("off" as PrivacyMode);
			},
			extraDataCollecting: new Set<string>(["my-custom-model"]),
		});
		expect(resolvePrivacyTier("my-custom-model")).toBe("data-collecting");
		expect(resolvePrivacyMode("my-custom-model")).toBe("block");
		expect(resolvePrivacyTier("some-other-model")).toBe("zero-retention");
		__resetPrivacyPolicy();
	});
	it("setPrivacyPolicy(null) restores default; getter works", () => {
		setPrivacyPolicy(null);
		expect(getPrivacyPolicy().resolveMode("big-pickle", "data-collecting")).toBe("block");
		expect(resolvePrivacyMode("big-pickle")).toBe("block");
	});
});
