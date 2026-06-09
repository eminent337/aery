import { describe, expect, it } from "vitest";
import {
	type CacheTimestamps,
	type ProactivePruneConfig,
	shouldProactivePrune,
} from "../src/compaction/proactive-prune";

const DEFAULT_CONFIG: ProactivePruneConfig = {
	contextWindow: 200_000,
	thresholdPercent: 85,
	cacheExpiryMs: 5 * 60 * 1000,
};

describe("shouldProactivePrune", () => {
	it("returns true when context exceeds threshold", () => {
		expect(shouldProactivePrune(180_000, undefined, DEFAULT_CONFIG)).toBe(true);
	});

	it("returns false when context is under threshold", () => {
		expect(shouldProactivePrune(100_000, undefined, DEFAULT_CONFIG)).toBe(false);
	});

	it("returns false when context equals threshold", () => {
		expect(shouldProactivePrune(170_000, undefined, DEFAULT_CONFIG)).toBe(false);
	});

	it("returns true when cache will miss (gap > cacheExpiryMs)", () => {
		const now = Date.now();
		const timestamps: CacheTimestamps = {
			lastAssistantAt: now - 10 * 60 * 1000, // 10 min ago
			userPromptAt: now,
		};
		expect(shouldProactivePrune(100_000, timestamps, DEFAULT_CONFIG)).toBe(true);
	});

	it("returns false when cache is fresh (gap < cacheExpiryMs)", () => {
		const now = Date.now();
		const timestamps: CacheTimestamps = {
			lastAssistantAt: now - 1 * 60 * 1000, // 1 min ago
			userPromptAt: now,
		};
		expect(shouldProactivePrune(100_000, timestamps, DEFAULT_CONFIG)).toBe(false);
	});

	it("returns false when no timestamps provided", () => {
		expect(shouldProactivePrune(100_000, undefined, DEFAULT_CONFIG)).toBe(false);
	});

	it("returns true when both threshold and cache miss", () => {
		const now = Date.now();
		const timestamps: CacheTimestamps = {
			lastAssistantAt: now - 10 * 60 * 1000,
			userPromptAt: now,
		};
		expect(shouldProactivePrune(180_000, timestamps, DEFAULT_CONFIG)).toBe(true);
	});

	it("returns false when contextWindow is 0 (disabled)", () => {
		const config: ProactivePruneConfig = {
			contextWindow: 0,
			thresholdPercent: 85,
			cacheExpiryMs: 5 * 60 * 1000,
		};
		expect(shouldProactivePrune(100_000, undefined, config)).toBe(false);
	});

	it("handles exact cacheExpiryMs boundary (gap equals expiry)", () => {
		const now = Date.now();
		const timestamps: CacheTimestamps = {
			lastAssistantAt: now - 5 * 60 * 1000, // exactly 5 min ago
			userPromptAt: now,
		};
		// gap === cacheExpiryMs, not greater, so false
		expect(shouldProactivePrune(100_000, timestamps, DEFAULT_CONFIG)).toBe(false);
	});
});
