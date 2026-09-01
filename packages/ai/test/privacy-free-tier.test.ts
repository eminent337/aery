import { describe, expect, it } from "bun:test";
import { isFreeTierModelId } from "../src/privacy/free-tier";

describe("privacy free-tier marker", () => {
	it("flags openrouter free aliases", () => {
		for (const id of ["openrouter/free", "kilo-auto/free", "kilo/auto-free"]) {
			expect(isFreeTierModelId(id)).toBe(true);
		}
	});
	it("flags :free and -free suffixes", () => {
		for (const id of [
			"openai/gpt-oss-20b:free",
			"deepseek/deepseek-v4-flash:free",
			"x-ai/grok-code-fast-1:optimized:free",
			"google/gemma-3-27b-it:free",
			"muse-spark-1.2-contributor-free",
			"glm-5-free",
			"kimi-k2.5-free",
			"deepseek-v4-flash-free",
			"google/gemini-3.5-flash-free",
			"xiaomi/mimo-v2-flash-free",
		]) {
			expect(isFreeTierModelId(id)).toBe(true);
		}
	});
	it("is case-insensitive", () => {
		expect(isFreeTierModelId("OPENROUTER/FREE")).toBe(true);
		expect(isFreeTierModelId("OpenAI/GPT-OSS-20B:Free")).toBe(true);
		expect(isFreeTierModelId("MUSE-SPARK-1.2-CONTRIBUTOR-FREE")).toBe(true);
	});
	it("does not flag non-free ids", () => {
		for (const id of [
			"gpt-4o-mini",
			"gpt-5",
			"claude-sonnet-4-5",
			"claude-opus",
			"gemini-2.5-pro",
			"llama-3.3-70b",
			"deepseek/deepseek-v4-flash",
			"openrouter/auto",
			"azure/gpt-4o",
			"kimi-k2.5",
			"ollama/llama3",
			"",
		]) {
			expect(isFreeTierModelId(id)).toBe(false);
		}
	});
	it("does not over-match providers that merely contain 'free' as a word", () => {
		// base2-free is a Codebuff model id and DOES end in -free, but the
		// marker predicate intentionally matches it at the id level; the
		// privacy tier uses the same predicate so it lands data-collecting,
		// which is the conservative-but-correct outcome for an unknown free
		// id. This test documents the behavior rather than forbidding it.
		expect(isFreeTierModelId("base2-free")).toBe(true);
	});
});
