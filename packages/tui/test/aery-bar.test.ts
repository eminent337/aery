import { describe, expect, it } from "bun:test";
import { AeryBar } from "../src/components/aery-bar";
import { visibleWidth } from "../src/utils";

describe("AeryBar", () => {
	it("renders exactly one line", () => {
		const bar = new AeryBar();
		bar.setSegments([{ text: "AERY", accent: true }, { text: "gpt-4o" }]);
		expect(bar.render(80)).toHaveLength(1);
	});

	it("visible width equals requested width", () => {
		const bar = new AeryBar();
		bar.setSegments([{ text: "AERY", accent: true }, { text: "model" }]);
		const line = bar.render(40)[0]!;
		expect(visibleWidth(line)).toBe(40);
	});

	it("returns empty array for width=0", () => {
		const bar = new AeryBar();
		bar.setSegments([{ text: "x" }]);
		expect(bar.render(0)).toEqual([]);
	});

	it("invalidate resets cache", () => {
		const bar = new AeryBar();
		bar.setSegments([{ text: "A" }]);
		const first = bar.render(20);
		bar.invalidate();
		const second = bar.render(20);
		expect(second).toEqual(first);
	});
});
