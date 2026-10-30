import { beforeAll, describe, expect, it } from "bun:test";
import {
	formatContextUsage,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "../../../src/modes/components/status-line/context-thresholds";
import { renderSegment } from "../../../src/modes/components/status-line/segments";
import type { SegmentContext } from "../../../src/modes/components/status-line/types";
import { initTheme } from "../../../src/modes/theme/theme";

describe("Context Token Pressure Gauge", () => {
	beforeAll(async () => {
		await initTheme();
	});

	describe("formatContextUsage", () => {
		it("formats with usedTokens, contextWindow, and percentage", () => {
			const formatted = formatContextUsage(32.8, 128_000, 42_000);
			expect(formatted).toBe("42K/128K (32.8%)");
		});

		it("formats zero usedTokens correctly", () => {
			const formatted = formatContextUsage(0, 128_000, 0);
			expect(formatted).toBe("0/128K (0.0%)");
		});

		it("handles unknown percentage when usedTokens is provided", () => {
			const formatted = formatContextUsage(null, 128_000, 5_000);
			expect(formatted).toBe("5K/128K (?)");
		});

		it("maintains backwards compatibility when usedTokens is omitted", () => {
			const formatted = formatContextUsage(32.8, 128_000);
			expect(formatted).toBe("32.8%/128K");

			const unknown = formatContextUsage(null, 128_000);
			expect(unknown).toBe("?/128K");
		});
	});

	describe("threshold levels and colors", () => {
		it("returns correct level for each threshold", () => {
			expect(getContextUsageLevel(20, 100_000)).toBe("normal");
			expect(getContextUsageLevel(55, 100_000)).toBe("warning");
			expect(getContextUsageLevel(75, 100_000)).toBe("purple");
			expect(getContextUsageLevel(95, 100_000)).toBe("error");
		});

		it("maps levels to appropriate theme colors", () => {
			expect(getContextUsageThemeColor("normal")).toBe("statusLineContext");
			expect(getContextUsageThemeColor("warning")).toBe("warning");
			expect(getContextUsageThemeColor("purple")).toBe("thinkingHigh");
			expect(getContextUsageThemeColor("error")).toBe("error");
		});
	});

	describe("context_pct segment rendering", () => {
		it("renders usedTokens/contextWindow (percent%) in context_pct segment", () => {
			const fakeContext = {
				contextPercent: 32.8,
				contextWindow: 128_000,
				usedTokens: 42_000,
				autoCompactEnabled: false,
			} as unknown as SegmentContext;

			const result = renderSegment("context_pct", fakeContext);
			expect(result.visible).toBe(true);
			expect(result.content).toContain("42K/128K (32.8%)");
		});
	});
});
