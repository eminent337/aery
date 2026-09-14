import { describe, expect, test } from "bun:test";
import { detectPlatformDriver, detectPlatformId, physicalToLogical } from "../desktop-drivers";

describe("platform driver detection (D001 cross-platform)", () => {
	test("hyprland wins when the signature is present", () => {
		expect(detectPlatformId({ HYPRLAND_INSTANCE_SIGNATURE: "abc" } as NodeJS.ProcessEnv, "linux")).toBe("hyprland");
		expect(detectPlatformDriver({ HYPRLAND_INSTANCE_SIGNATURE: "abc" } as NodeJS.ProcessEnv, "linux").id).toBe("hyprland");
	});
	test("pure x11 session resolves to x11", () => {
		expect(detectPlatformId({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" } as NodeJS.ProcessEnv, "linux")).toBe("x11");
	});
	test("darwin and win32 resolve to their stubs", () => {
		expect(detectPlatformId({}, "darwin")).toBe("macos");
		expect(detectPlatformId({}, "win32")).toBe("windows");
	});
	test("hyprland driver exposes window + capture surfaces", () => {
		const d = detectPlatformDriver({ HYPRLAND_INSTANCE_SIGNATURE: "abc" } as NodeJS.ProcessEnv, "linux");
		expect(typeof d.windows.listWindows).toBe("function");
		expect(typeof d.capture.capture).toBe("function");
		expect(typeof d.capture.cursorPos).toBe("function");
	});
	test("macos/windows stubs report honest gaps", () => {
		expect(detectPlatformDriver({}, "darwin").label).toMatch(/macOS/);
		expect(detectPlatformDriver({}, "win32").label).toMatch(/Windows/);
	});
});

describe("physicalToLogical (D002 scale correctness)", () => {
	test("scale 1 is the identity", () => {
		expect(physicalToLogical(1920, 1080, 1)).toEqual({ x: 1920, y: 1080 });
	});
	test("scale 1.5 divides physical px into logical units", () => {
		expect(physicalToLogical(768, 432, 1.5)).toEqual({ x: 512, y: 288 });
	});
	test("scale 2 halves coordinates", () => {
		expect(physicalToLogical(1000, 500, 2)).toEqual({ x: 500, y: 250 });
	});
	test("non-positive scale is a safe no-op (defensive)", () => {
		expect(physicalToLogical(10, 20, 0)).toEqual({ x: 10, y: 20 });
		expect(physicalToLogical(10, 20, -1)).toEqual({ x: 10, y: 20 });
	});
});
