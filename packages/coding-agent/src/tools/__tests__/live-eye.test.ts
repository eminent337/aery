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

describe("live_eye vision auto-detection (pure logic)", () => {
	// Mirrors the decision logic in desktop-control live_eye:
	//   modelSeesImages = session?.supportsVision?.() ?? true
	//   wantOcr = params.ocr ?? !modelSeesImages
	//   textOnly = !modelSeesImages || params.ocr === true
	function decide(supportsVision: (() => boolean | undefined) | undefined, ocr?: boolean) {
		const modelSeesImages = supportsVision?.() ?? true;
		const wantOcr = ocr ?? !modelSeesImages;
		const textOnly = !modelSeesImages || ocr === true;
		return { modelSeesImages, wantOcr, textOnly };
	}

	test("visionless model auto-OCRs and goes text-only", () => {
		expect(decide(() => false, undefined)).toEqual({ modelSeesImages: false, wantOcr: true, textOnly: true });
	});

	test("vision model keeps pixels, skips OCR by default", () => {
		expect(decide(() => true, undefined)).toEqual({ modelSeesImages: true, wantOcr: false, textOnly: false });
	});

	test("explicit ocr:true forces OCR + text-only even for vision", () => {
		expect(decide(() => true, true)).toEqual({ modelSeesImages: true, wantOcr: true, textOnly: true });
	});

	test("explicit ocr:false skips OCR even for visionless", () => {
		expect(decide(() => false, false)).toEqual({ modelSeesImages: false, wantOcr: false, textOnly: true });
	});

	test("unknown capability defaults to vision-keeping behavior", () => {
		expect(decide(undefined, undefined)).toEqual({ modelSeesImages: true, wantOcr: false, textOnly: false });
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
