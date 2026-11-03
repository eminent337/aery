import { describe, expect, test } from "bun:test";
import { probePngDimensions, resizePngBuffer } from "../src/tools/screen-buffer";

describe("screen-buffer", () => {
	// 1x1 transparent PNG buffer
	const samplePng = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
		"base64",
	);

	test("probePngDimensions correctly reads 1x1 dimensions from IHDR", () => {
		const dims = probePngDimensions(samplePng);
		expect(dims).toEqual([1, 1]);
	});

	test("probePngDimensions returns null for non-PNG or corrupted buffer", () => {
		expect(probePngDimensions(Buffer.from("not a png"))).toBeNull();
		expect(probePngDimensions(Buffer.alloc(10))).toBeNull();
	});

	test("resizePngBuffer returns original buffer when within max dimensions", async () => {
		const res = await resizePngBuffer(samplePng, 1920, 1080);
		expect(res.width).toBe(1);
		expect(res.height).toBe(1);
		expect(res.buffer).toEqual(samplePng);
	});
});
