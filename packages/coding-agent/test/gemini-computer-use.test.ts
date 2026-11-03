import { describe, expect, test } from "bun:test";
import { denormalizeCoordinate, GeminiComputerUseTool } from "../src/tools/gemini-computer-use";

describe("gemini-computer-use", () => {
	test("denormalizeCoordinate scales 0..1000 to 1920x1080 display", () => {
		expect(denormalizeCoordinate(0, 1920)).toBe(0);
		expect(denormalizeCoordinate(500, 1920)).toBe(960);
		expect(denormalizeCoordinate(1000, 1920)).toBe(1919); // clamped to bounds
		expect(denormalizeCoordinate(250, 1080)).toBe(270);
	});

	test("denormalizeCoordinate preserves physical pixels if > 1000", () => {
		expect(denormalizeCoordinate(1440, 1920)).toBe(1440);
	});

	test("denormalizeCoordinate clamps negative values to 0", () => {
		expect(denormalizeCoordinate(-50, 1920)).toBe(0);
	});

	test("GeminiComputerUseTool exposes correct schema and metadata", () => {
		const tool = new GeminiComputerUseTool();
		expect(tool.name).toBe("gemini_computer_use");
		expect(tool.parameters).toBeDefined();
	});
});
