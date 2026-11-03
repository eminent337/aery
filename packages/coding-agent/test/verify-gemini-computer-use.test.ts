import { describe, expect, test } from "bun:test";
import { GeminiComputerUseTool, BUILTIN_TOOLS } from "../src/tools";

describe("verify-gemini-computer-use registration", () => {
	test("gemini_computer_use and computer_use are registered in BUILTIN_TOOLS", () => {
		expect(BUILTIN_TOOLS.gemini_computer_use).toBeDefined();
		expect(BUILTIN_TOOLS.computer_use).toBeDefined();
	});

	test("GeminiComputerUseTool class is exported", () => {
		expect(GeminiComputerUseTool).toBeDefined();
	});
});
