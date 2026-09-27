import { describe, expect, test } from "bun:test";
import {
	buildEyeGeometry,
	describeEyeTarget,
	type EyeWindow,
	eyeMarkPresent,
	shouldUseFocusedFrame,
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

describe("live_eye vision auto-detection (pure logic)", () => {
	// Mirrors the decision logic in desktop-control live_eye:
	//   modelSeesImages = session?.supportsVision?.() ?? true
	//   wantOcr = params.ocr ?? (!modelSeesImages || textOnly)
	// textOnly means "words, not pixels", so it implies OCR — otherwise a
	// vision-default caller asking textOnly gets neither pixels nor text.
	function decide(supportsVision: (() => boolean | undefined) | undefined, ocr: boolean | undefined, textOnly: boolean) {
		const modelSeesImages = supportsVision?.() ?? true;
		const wantOcr = ocr ?? (!modelSeesImages || textOnly);
		return { modelSeesImages, wantOcr };
	}

	test("visionless model auto-OCRs", () => {
		expect(decide(() => false, undefined, false)).toEqual({ modelSeesImages: false, wantOcr: true });
	});

	test("vision model skips OCR by default", () => {
		expect(decide(() => true, undefined, false)).toEqual({ modelSeesImages: true, wantOcr: false });
	});

	test("textOnly implies OCR even when vision defaults true", () => {
		expect(decide(() => true, undefined, true)).toEqual({ modelSeesImages: true, wantOcr: true });
		expect(decide(undefined, undefined, true)).toEqual({ modelSeesImages: true, wantOcr: true });
	});

	test("explicit ocr:true forces OCR even for vision", () => {
		expect(decide(() => true, true, false)).toEqual({ modelSeesImages: true, wantOcr: true });
	});

	test("explicit ocr:false skips OCR even for visionless", () => {
		expect(decide(() => false, false, false)).toEqual({ modelSeesImages: false, wantOcr: false });
	});

	test("unknown capability defaults to vision-keeping behavior", () => {
		expect(decide(undefined, undefined, false)).toEqual({ modelSeesImages: true, wantOcr: false });
	});
});

describe("focusFirst framing opt-in (pure logic)", () => {
	const win: EyeWindow = { at: [524, 586], size: [540, 472], title: "Dialog", class: "yad" };

	test("upgrades a bare fullscreen glance to the focused window", () => {
		expect(shouldUseFocusedFrame("fullscreen", true, win)).toBe(true);
	});

	test("default (focusFirst off) never changes the frame", () => {
		expect(shouldUseFocusedFrame("fullscreen", false, win)).toBe(false);
	});

	test("never rewrites a target the caller named explicitly", () => {
		expect(shouldUseFocusedFrame("active_window", true, win)).toBe(false);
		expect(shouldUseFocusedFrame("kitty", true, win)).toBe(false);
		expect(shouldUseFocusedFrame("my window title", true, win)).toBe(false);
	});

	test("falls back to fullscreen when no window is focused", () => {
		expect(shouldUseFocusedFrame("fullscreen", true, undefined)).toBe(false);
	});

	test("a window that cannot be cropped never becomes the frame", () => {
		// A 0x0 or missing-size window would produce a degenerate capture; the
		// eye must degrade to fullscreen instead of framing nothing.
		const zero: EyeWindow = { at: [0, 0], size: [0, 0] };
		const flat: EyeWindow = { at: [0, 0], size: [540, 0] };
		const negative: EyeWindow = { at: [0, 0], size: [-5, 100] };
		const noSize: EyeWindow = { at: [0, 0] };
		expect(shouldUseFocusedFrame("fullscreen", true, zero)).toBe(false);
		expect(shouldUseFocusedFrame("fullscreen", true, flat)).toBe(false);
		expect(shouldUseFocusedFrame("fullscreen", true, negative)).toBe(false);
		expect(shouldUseFocusedFrame("fullscreen", true, noSize)).toBe(false);
	});

	test("a window with a real rect and no position still frames (origin 0,0)", () => {
		expect(shouldUseFocusedFrame("fullscreen", true, { size: [800, 600] })).toBe(true);
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
