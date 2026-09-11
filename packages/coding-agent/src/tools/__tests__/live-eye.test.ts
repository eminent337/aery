import { describe, expect, test } from "bun:test";
import {
	buildEyeGeometry,
	describeEyeTarget,
	eyeMarkPresent,
} from "../live-eye";

describe("live_eye geometry + targeting (pure logic)", () => {
	test("region wins over window target", () => {
		const g = buildEyeGeometry({ x: 10, y: 20, w: 300, h: 200 }, undefined);
		expect(g).toBe("10,20 300x200");
	});

	test("window geometry from at/size", () => {
		const g = buildEyeGeometry(undefined, { at: [22, 90], size: [920, 472] });
		expect(g).toBe("22,90 920x472");
	});

	test("fullscreen target yields undefined geometry", () => {
		const g = buildEyeGeometry(undefined, undefined);
		expect(g).toBeUndefined();
	});

	test("zero-size window falls back to fullscreen", () => {
		const g = buildEyeGeometry(undefined, { at: [0, 0], size: [0, 0] });
		expect(g).toBeUndefined();
	});

	test("describeEyeTarget prefers window title", () => {
		expect(
			describeEyeTarget({ title: "Book1.xlsx", class: "ONLYOFFICE" }, undefined, "active_window"),
		).toContain("Book1.xlsx");
	});

	test("describeEyeTarget falls back to target name", () => {
		expect(describeEyeTarget(undefined, undefined, "fullscreen")).toContain("fullscreen");
	});
});

describe("live_eye marker contract", () => {
	test("eyeMarkPresent detects the details marker", () => {
		expect(eyeMarkPresent({ liveEye: { at: 123 } })).toBe(true);
		expect(eyeMarkPresent({})).toBe(false);
		expect(eyeMarkPresent(null)).toBe(false);
		expect(eyeMarkPresent(undefined)).toBe(false);
		expect(eyeMarkPresent({ liveEye: "not-an-object" })).toBe(false);
	});
});
