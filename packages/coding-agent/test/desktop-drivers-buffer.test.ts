import { describe, expect, test } from "bun:test";
import { detectPlatformDriver } from "../src/tools/desktop-drivers";

describe("desktop-drivers captureBuffer", () => {
	test("driver provides captureBuffer method", () => {
		const driver = detectPlatformDriver();
		expect(typeof driver.capture.captureBuffer).toBe("function");
	});
});
