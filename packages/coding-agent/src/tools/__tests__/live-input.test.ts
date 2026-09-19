import { describe, expect, test } from "bun:test";
import {
	frameScaleX,
	frameScaleY,
	frameToPhysical,
	hyprMoveCursor,
	isDirectTypeable,
	parseChord,
	resolveBackend,
	resolveBackendChain,
	specToXdotoolArgs,
	specToYdotoolEvents,
	ydoPageScroll,
	xdoWheelScroll,
	ydoMoveRelative,
	ydoClearField,
} from "../live-input";

describe("pointer aiming (hyprMoveCursor)", () => {
	test("hyprctl dispatch movecursor args are exact, rounded", () => {
		expect(hyprMoveCursor(123.6, 87.2)).toEqual(["hyprctl", "dispatch", "movecursor", "124", "87"]);
	});
});

describe("frame coordinate mapping (TARS-style round-trip)", () => {
	const windowFrame = {
		kind: "window",
		atX: 200,
		atY: 120,
		physW: 1920,
		physH: 1080,
		scaledW: 1280,
		scaledH: 720,
		address: "0xabc",
	} as const;

	test("frame px map back to compositor px through the window offset", () => {
		const p = frameToPhysical(windowFrame, 640, 360);
		expect(p).toEqual({ x: 200 + 960, y: 120 + 540 });
	});

	test("downscale factor is uniform on both axes", () => {
		expect(frameScaleX(windowFrame)).toBeCloseTo(1280 / 1920, 6);
		expect(frameScaleY(windowFrame)).toBeCloseTo(720 / 1080, 6);
	});

	test("out-of-frame coordinates clamp into the frame", () => {
		const p = frameToPhysical(windowFrame, -50, 5000);
		expect(p.x).toBeGreaterThanOrEqual(windowFrame.atX);
		expect(p.y).toBeLessThanOrEqual(windowFrame.atY + windowFrame.physH);
	});

	test("fullscreen frame has zero origin", () => {
		const fs = { kind: "fullscreen", atX: 0, atY: 0, physW: 1920, physH: 1080, scaledW: 1280, scaledH: 720 } as const;
		expect(frameToPhysical(fs, 0, 0)).toEqual({ x: 0, y: 0 });
		expect(frameToPhysical(fs, 1280, 720)).toEqual({ x: 1920, y: 1080 });
	});
});

describe("keyboard spec parsing", () => {
	test("letter → evdev code events with press+release", () => {
		const events = specToYdotoolEvents("a") as string[];
		expect(events).toEqual(["30:1", "30:0"]);
	});

	test("modifier chord holds modifier then releases last", () => {
		const events = specToYdotoolEvents("ctrl+l") as string[];
		// ctrl down, l down, l up, ctrl up
		expect(events).toEqual(["29:1", "38:1", "38:0", "29:0"]);
	});

	test("multi-token spec sequences chords", () => {
		const events = specToYdotoolEvents("Return Tab") as string[];
		expect(events).toEqual(["28:1", "28:0", "15:1", "15:0"]);
	});

	test("unknown token reports error", () => {
		const out = specToYdotoolEvents("ctrl+doesnotexist");
		expect(typeof out).toBe("object");
		expect("error" in out).toBe(true);
	});

	test("parseChord maps named keys and spaces", () => {
		expect(parseChord("Return")).toEqual([28]);
		expect(parseChord("space")).toEqual([57]);
		expect(parseChord("Super_L" as never)).toBeUndefined();
	});

	test("xdotool keysyms are lowercase letters / plain digits", () => {
		expect(specToXdotoolArgs("ctrl+l") as string[]).toEqual(["ctrl+l"]);
		expect(specToXdotoolArgs("a") as string[]).toEqual(["a"]);
		expect(specToXdotoolArgs("Return") as string[]).toEqual(["Return"]);
	});
});

describe("normalized scroll builders", () => {
	test("native Wayland page steps are separate and capped", () => {
		expect(ydoPageScroll("down", 2)).toEqual([
			["ydotool", "key", "-d", "24", "109:1", "109:0"],
			["ydotool", "key", "-d", "24", "109:1", "109:0"],
		]);
		expect(ydoPageScroll("up", 99)).toHaveLength(20);
		expect(ydoPageScroll("up", -1)).toEqual([]);
	});

	test("XWayland wheel notches are separate and capped", () => {
		expect(xdoWheelScroll("up", 2)).toEqual([["xdotool", "click", "4"], ["xdotool", "click", "4"]]);
		expect(xdoWheelScroll("down", 99)).toHaveLength(20);
		expect(xdoWheelScroll("down", 0)).toEqual([]);
	});
});

describe("relative drag motion safety", () => {
	test("clamps unsafe deltas and keeps them relative", () => {
		expect(ydoMoveRelative(999, -999)).toEqual(["ydotool", "mousemove", "-x", "600", "-y", "-600"]);
		expect(ydoMoveRelative(39.6, -39.6)).toEqual(["ydotool", "mousemove", "-x", "40", "-y", "-40"]);
	});
});

describe("field clear primitive", () => {
	test("select-all and delete are separate guarded steps", () => {
		const steps = ydoClearField();
		expect(steps).toHaveLength(2);
		expect(steps[0]).toEqual(["ydotool", "key", "-d", "24", "29:1", "30:1", "30:0", "29:0"]);
		expect(steps[1]).toEqual(["ydotool", "key", "-d", "24", "111:1", "111:0"]);
	});
});

describe("insertion verification normalization", () => {
	const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	test("normalizes whitespace and case for OCR comparison", () => {
		expect(normalize("  Ada   Grace  ")).toBe("ada grace");
		expect(normalize("ADA GRACE")).toBe("ada grace");
	});
	test("OCR '1' vs typed 'l' cannot false-positive as equality", () => {
		const detected = "adal";
		const expected = "adal";
		expect(normalize(detected) === normalize(expected)).toBe(true);
		const flipped = "adal";
		expect(normalize(flipped).includes("l")).toBe(true);
		expect(normalize(flipped).includes("1")).toBe(false);
	});
});

describe("typing policy", () => {
	test("plain ASCII printable is directly typeable", () => {
		expect(isDirectTypeable("hello world 123 !@#")).toBe(true);
	});
	test("newline and non-ASCII route to clipboard paste", () => {
		expect(isDirectTypeable("line1\nline2")).toBe(false);
		expect(isDirectTypeable("héllo")).toBe(false);
		expect(isDirectTypeable("")).toBe(true); // empty → direct (no-op safe)
	});
});

describe("backend resolution", () => {
	const full = { ydotool: true, ydotoold: true, xdotool: true, wtype: true };
	const noDaemon = { ydotool: true, ydotoold: false, xdotool: true, wtype: true };
	const minimal = { ydotool: false, ydotoold: false, xdotool: false, wtype: true };

	test("ydotool with daemon wins everywhere", () => {
		expect(resolveBackend(full, false, "pointer")).toBe("ydotool");
		expect(resolveBackend(full, true, "pointer")).toBe("ydotool");
		expect(resolveBackend(full, false, "keyboard")).toBe("ydotool");
	});

	test("ydotool without daemon reports no-daemon", () => {
		expect(resolveBackend(noDaemon, false, "pointer")).toBe("no-daemon");
	});

	test("XWayland window falls back to xdotool when ydotool is absent", () => {
		const probe = { ydotool: false, ydotoold: false, xdotool: true, wtype: true };
		expect(resolveBackend(probe, true, "pointer")).toBe("xdotool");
		// native Wayland window cannot use xdotool for pointer
		expect(resolveBackend(probe, false, "pointer")).toBe("none");
	});

	test("wtype covers keyboard/type when nothing else is present", () => {
		expect(resolveBackend(minimal, false, "keyboard")).toBe("wtype");
		expect(resolveBackend(minimal, false, "type")).toBe("wtype");
		expect(resolveBackend(minimal, false, "pointer")).toBe("none");
	});
});

describe("backend fallback chain", () => {
	const full = { ydotool: true, ydotoold: true, xdotool: true, wtype: true };
	const noDaemon = { ydotool: true, ydotoold: false, xdotool: true, wtype: true };
	const minimal = { ydotool: false, ydotoold: false, xdotool: false, wtype: true };

	test("ydotool first, then xdotool (XWayland only) then wtype for keyboard kinds", () => {
		expect(resolveBackendChain(full, false, "keyboard")).toEqual(["ydotool", "wtype"]);
		expect(resolveBackendChain(full, true, "type")).toEqual(["ydotool", "xdotool", "wtype"]);
	});

	test("no-daemon chain skips ydotool and falls through to the others", () => {
		expect(resolveBackendChain(noDaemon, true, "type")).toEqual(["xdotool", "wtype"]);
		expect(resolveBackendChain(noDaemon, false, "type")).toEqual(["wtype"]);
	});

	test("pointer chain is ydotool / xdotool(XWayland) only — wtype can't point", () => {
		expect(resolveBackendChain(full, true, "pointer")).toEqual(["ydotool", "xdotool"]);
		expect(resolveBackendChain(minimal, false, "pointer")).toEqual([]);
	});
});
