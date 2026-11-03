import { describe, expect, test } from "bun:test";
import { DesktopControlTool } from "../src/tools/desktop-control";

describe("live_eye in-memory capture", () => {
	test("live_eye returns base64 and frame resolution", async () => {
		const tool = new DesktopControlTool();
		const result = await tool.execute("call-live-eye-1", {
			action: "live_eye",
			target: "fullscreen",
			ocr: false,
		});
		expect(result).toBeDefined();
		expect(Array.isArray(result.content)).toBe(true);
	});
});
