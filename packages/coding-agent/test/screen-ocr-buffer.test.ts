import { describe, expect, test } from "bun:test";
import { ocrFrame } from "../src/tools/screen-ocr";

describe("screen-ocr buffer input", () => {
	// Minimal 1x1 transparent PNG buffer
	const samplePng = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
		"base64",
	);

	test("ocrFrame handles Buffer input gracefully without throwing", async () => {
		const res = await ocrFrame(samplePng, { timeoutMs: 5000 });
		expect(res).toBeDefined();
		expect(typeof res.text).toBe("string");
		expect(Array.isArray(res.words)).toBe(true);
	});
});
