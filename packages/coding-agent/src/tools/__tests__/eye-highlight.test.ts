import { describe, expect, test } from "bun:test";
import { bandBleed, boundingBox, frameRectToPhysical, highlightColor, highlightOverlayScript, layerGeometry, toBands } from "../eye-highlight";

const WINDOW_FRAME = {
	kind: "window" as const,
	atX: 598,
	atY: 90,
	physW: 1300,
	physH: 968,
	scaledW: 1074,
	scaledH: 800,
	address: "0xabc",
};

describe("eye-highlight geometry", () => {
	test("maps a frame-px rect to physical px at the frame origin", () => {
		const r = frameRectToPhysical(WINDOW_FRAME, { x: 59, y: 14, w: 60, h: 20 });
		expect(r).not.toBeNull();
		// scale = 1074/1300 = 0.8262; 59/0.8262 ≈ 71.4 → 598+71 = 669
		expect(r!.x).toBe(598 + 71);
		// y scale = 800/968 = 0.8264; 14/0.8264 ≈ 16.9 → 90+17 = 107
		expect(r!.y).toBe(90 + 17);
		expect(r!.w).toBe(73);
		expect(r!.h).toBe(24);
	});

	test("clamps rects that overflow the frame", () => {
		const r = frameRectToPhysical(WINDOW_FRAME, { x: 1050, y: 790, w: 200, h: 100 });
		expect(r).not.toBeNull();
		expect(r!.w).toBeGreaterThan(0);
		expect(r!.x + r!.w).toBeLessThanOrEqual(WINDOW_FRAME.atX + WINDOW_FRAME.physW);
	});

	test("rejects degenerate rects (zero size, empty frame)", () => {
		expect(frameRectToPhysical(WINDOW_FRAME, { x: 10, y: 10, w: 0, h: 10 })).toBeNull();
		expect(
			frameRectToPhysical({ kind: "fullscreen", atX: 0, atY: 0, physW: 0, physH: 0, scaledW: 0, scaledH: 0 }, {
				x: 1,
				y: 1,
				w: 5,
				h: 5,
			}),
		).toBeNull();
	});

	test("fullscreen frame maps without offset", () => {
		const r = frameRectToPhysical(
			{ kind: "fullscreen", atX: 0, atY: 0, physW: 1920, physH: 1080, scaledW: 1280, scaledH: 720 },
			{ x: 640, y: 360, w: 100, h: 50 },
		);
		expect(r).toEqual({ x: 960, y: 540, w: 150, h: 75 });
	});

	test("boundingBox unions rects", () => {
		const bb = boundingBox([
			{ x: 10, y: 20, w: 30, h: 40 },
			{ x: 100, y: 200, w: 50, h: 25 },
		]);
		expect(bb).toEqual({ x: 10, y: 20, w: 140, h: 205 });
		expect(boundingBox([])).toBeNull();
	});

	test("colors map per name with highlighter yellow as default", () => {
		const def = highlightColor(undefined);
		expect(def.r).toBe(1.0);
		expect(def.g).toBeGreaterThan(0.85); // yellow, not red
		expect(def.a).toBeGreaterThan(0.4); // a marker body, not a hairline
		expect(highlightColor("amber").g).toBeGreaterThan(0.5);
		expect(highlightColor("green").g).toBeGreaterThan(0.8);
		expect(highlightColor("cyan").b).toBeGreaterThan(0.8);
		expect(highlightColor("pink").r).toBe(1.0);
		expect(highlightColor("blue").b).toBeGreaterThan(0.8);
	});

	test("bandBleed grows the band so it covers the glyph line", () => {
		expect(bandBleed(10)).toBe(3);
		expect(bandBleed(40)).toBe(9);
	});

	test("toBands pads horizontally and bleeds vertically for a highlighter", () => {
		const bands = toBands([{ x: 100, y: 200, w: 40, h: 20 }], { pad: 5, style: "highlighter" });
		expect(bands[0].x).toBe(95); // 5px left pad
		expect(bands[0].w).toBe(50); // 40 + 2*5
		expect(bands[0].y).toBe(200 - bandBleed(20)); // vertical bleed from max height
		expect(bands[0].h).toBe(20 + 2 * bandBleed(20));
		const boxes = toBands([{ x: 100, y: 200, w: 40, h: 20 }], { pad: 6, style: "box" });
		expect(boxes[0]).toEqual({ x: 94, y: 194, w: 52, h: 32 });
	});

	test("layerGeometry subtracts reserved zones and divides by logical scale", () => {
		// A band at screen y=500 on a box with a 68px top bar must be placed at
		// marginTop = 500-68 = 432 (usable-area coords), NOT 500 — otherwise the
		// surface lands 68px low.
		const g = layerGeometry([{ x: 300, y: 500, w: 200, h: 30 }], { reserved: { left: 0, top: 68, right: 0, bottom: 0 } });
		expect(g).not.toBeNull();
		expect(g!.marginTop).toBe(432);
		expect(g!.marginLeft).toBe(300);
		expect(g!.width).toBe(200);
		expect(g!.height).toBe(30);
		expect(g!.bands[0]).toEqual({ x: 0, y: 0, w: 200, h: 30 });

		// Logical scale: physical px / scale for margins and size.
		const s = layerGeometry([{ x: 300, y: 500, w: 200, h: 30 }], { reserved: { left: 0, top: 68, right: 0, bottom: 0 }, scale: 2 });
		expect(s!.marginTop).toBe(216); // 432/2
		expect(s!.width).toBe(100);
		expect(s!.bands[0]).toEqual({ x: 0, y: 0, w: 100, h: 15 });
	});

	test("a band straddling the bar keeps its offset so it is drawn clipped", () => {
		// y=60 with a 68px bar: usable y = -8, so the top 8px sit behind the bar
		// and the surface is pinned to the usable origin.
		const g = layerGeometry([{ x: 10, y: 60, w: 100, h: 20 }], { reserved: { left: 0, top: 68, right: 0, bottom: 0 } });
		expect(g).not.toBeNull();
		expect(g!.marginTop).toBe(0); // pinned at the usable origin
		expect(g!.bands[0].y).toBe(-8); // 60-68: drawn above the surface, clipped
		expect(g!.bands[0].h).toBe(20);
	});

	test("a band fully behind the bar is dropped (nothing visible)", () => {
		expect(layerGeometry([{ x: 10, y: 5, w: 100, h: 3 }], { reserved: { left: 0, top: 68, right: 0, bottom: 0 } })).toBeNull();
	});

	test("layerGeometry is null for empty input", () => {
		expect(layerGeometry([])).toBeNull();
	});

	test("overlay script uses named cairo operators (numeric literals erase)", () => {
		const g = layerGeometry([{ x: 100, y: 200, w: 30, h: 12 }])!;
		const hi = highlightOverlayScript(g, { color: "yellow", ms: 1500, width: 3, style: "highlighter" });
		expect(hi).toContain("GtkLayerShell.Layer.OVERLAY");
		expect(hi).toContain("KeyboardMode.NONE");
		expect(hi).toContain("set_exclusive_zone(win, 0)");
		expect(hi).toContain("MS = 1500");
		expect(hi).toContain('STYLE = "highlighter"');
		expect(hi).toContain("cr.fill()"); // solid body, not just a stroke
		expect(hi).toContain("0.93"); // default yellow g
		// The exact bug fixed: operators must be symbolic, never 1 / 0.
		expect(hi).toContain("cairo.OPERATOR_CLEAR");
		expect(hi).toContain("cairo.OPERATOR_OVER");
		expect(hi).not.toMatch(/set_operator\([012]\)/);
		const box = highlightOverlayScript(g, { color: "amber", ms: 1500, width: 3, style: "box" });
		expect(box).toContain('STYLE = "box"');
		expect(box).toContain("WIDTH = 3");
		expect(box).toContain("0.72"); // amber g
	});

	test("script embeds the surface geometry and encodes a dissolve", () => {
		const g = layerGeometry([{ x: 400, y: 468, w: 120, h: 20 }], { reserved: { left: 0, top: 68, right: 0, bottom: 0 } })!;
		const s = highlightOverlayScript(g, { ms: 2000, width: 4 });
		const unescaped = s.replace(/\\(.)/g, "$1");
		expect(unescaped).toContain('"marginTop":400'); // 468-68
		expect(unescaped).toContain('"marginLeft":400');
		expect(s).toContain("FADE_MS");
		expect(s).toContain("start_fade");
		expect(s).toContain("0.99"); // alpha starts below full → dissolve begins
	});
});
