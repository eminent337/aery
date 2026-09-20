import { describe, expect, test } from "bun:test";

/** Pins for the headless drive path (phase 2).
 *  NEW behavior (must fail first): resolveXvfbTarget (word-anchored clicks
 *  against the xvfb eye store), buildXvfbTypeArgs/buildXvfbKeyArgs (window
 *  activation before typing/keys).
 *  REGRESSION LOCKS (already landed in phase 1, kept as guards):
 *  xvfbFrameToDisplay mapping math + out-of-bounds refusal. */

describe("resolveXvfbTarget (word-anchored headless clicks)", () => {
	test("resolves a remembered xvfb eye target to its scaled-frame center", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets([
			{ text: "APPROVE", x: 82, y: 108, w: 231, h: 38, confidence: 0.9 },
			{ text: "CANCEL", x: 405, y: 108, w: 195, h: 38, confidence: 0.96 },
		]);
		const hit = m.resolveXvfbTarget("approve");
		expect(hit).not.toBeNull();
		expect(hit!.x).toBe(82 + Math.round(231 / 2));
		expect(hit!.y).toBe(108 + Math.round(38 / 2));
	});

	test("prefers exact match over substring, shortest label over sentence", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets([
			{ text: "Send Report", x: 0, y: 100, w: 200, h: 40, confidence: 0.9 },
			{ text: "SEND", x: 0, y: 200, w: 90, h: 40, confidence: 0.9 },
		]);
		// Center of the SEND box: y 200 + h/2 (resolve returns the center).
		expect(m.resolveXvfbTarget("send")!.y).toBe(220);
		m.rememberXvfbTargets([
			{ text: "Settings Overview", x: 0, y: 300, w: 300, h: 40, confidence: 0.9 },
			{ text: "Settings", x: 0, y: 400, w: 120, h: 40, confidence: 0.9 },
		]);
		// Center again: y 400 + h/2 = 420 for the exact, shortest match.
		expect(m.resolveXvfbTarget("settings")!.y).toBe(420);
	});

	test("returns null for unknown targets (fail-closed, no blind click)", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets([{ text: "APPROVE", x: 0, y: 0, w: 10, h: 10, confidence: 0.9 }]);
		expect(m.resolveXvfbTarget("nonexistent")).toBeNull();
		expect(m.resolveXvfbTarget("")).toBeNull();
	});

	test("skips merged column fragments: crisp B2 beats a tall (B2 smear)", async () => {
		const m = await import("../desktop-control");
		// What tesseract yields on a small-cell grid: one clean label plus a
		// tall merged fragment in the same column that also contains "B2".
		m.rememberXvfbTargets([
			{ text: "(B2", x: 300, y: 200, w: 60, h: 190, confidence: 0.5 },
			{ text: "B2", x: 300, y: 250, w: 50, h: 30, confidence: 0.93 },
		]);
		const hit = m.resolveXvfbTarget("B2")!;
		expect(hit.box.text).toBe("B2");
		expect(hit.box.h).toBe(30);
	});

	test("falls back to a fragment match when nothing sane matches", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets([{ text: "ARR]", x: 100, y: 200, w: 60, h: 190, confidence: 0.24 }]);
		const hit = m.resolveXvfbTarget("arr");
		expect(hit).not.toBeNull();
	});
});

describe("buildXvfbTypeArgs / buildXvfbKeyArgs (activate before input)", () => {
	test("type argv activates the window first, then types", async () => {
		const { buildXvfbTypeArgs } = await import("../desktop-control");
		expect(buildXvfbTypeArgs("hello world", "0x1234")).toEqual([
			"windowactivate",
			"--sync",
			"0x1234",
			"type",
			"--delay",
			"40",
			"hello world",
		]);
	});

	test("key argv activates the window first, then sends keys", async () => {
		const { buildXvfbKeyArgs } = await import("../desktop-control");
		expect(buildXvfbKeyArgs("Return", "0x1234")).toEqual(["windowactivate", "--sync", "0x1234", "key", "Return"]);
	});

	test("omits activation when no window id is known", async () => {
		const { buildXvfbTypeArgs, buildXvfbKeyArgs } = await import("../desktop-control");
		expect(buildXvfbTypeArgs("hi", undefined)).toEqual(["type", "--delay", "40", "hi"]);
		expect(buildXvfbKeyArgs("Tab", undefined)).toEqual(["key", "Tab"]);
	});
});

describe("xvfbFrameToDisplay (regression lock: phase-1 mapping)", () => {
	test("maps scaled-frame px to raw display px", async () => {
		const { xvfbFrameToDisplay } = await import("../desktop-control");
		const f = { physW: 1600, physH: 900, scaledW: 1280, scaledH: 720 };
		expect(xvfbFrameToDisplay(198, 127, f)).toEqual([248, 159]);
		expect(xvfbFrameToDisplay(0, 0, f)).toEqual([0, 0]);
		expect(xvfbFrameToDisplay(1279, 719, f)).toEqual([1599, 899]); // round(1279×1.25), round(719×1.25)
	});

	test("passthrough when no frame exists (coords are already display px)", async () => {
		const { xvfbFrameToDisplay } = await import("../desktop-control");
		expect(xvfbFrameToDisplay(800, 450, null)).toEqual([800, 450]);
	});
});

describe("xvfbNewWindows (launch diff: name THIS launch's windows)", () => {
	test("returns only windows absent before the launch", async () => {
		const { xvfbNewWindows } = await import("../desktop-control");
		expect(xvfbNewWindows(["AeryAim2"], ["AeryAim2", "AeryBench"])).toEqual(["AeryBench"]);
	});

	test("is empty when a pre-existing window is all that mounted", async () => {
		// Regression: polling returned instantly on AeryAim2 alone, so the
		// second launch named the wrong app. The diff must stay empty here.
		const { xvfbNewWindows } = await import("../desktop-control");
		expect(xvfbNewWindows(["AeryAim2"], ["AeryAim2"])).toEqual([]);
	});

	test("matches case- and whitespace-insensitively", async () => {
		const { xvfbNewWindows } = await import("../desktop-control");
		expect(xvfbNewWindows([" AeryAim2 "], ["aeryaim2", "AeryBench"])).toEqual(["AeryBench"]);
	});

	test("returns everything on a cold display", async () => {
		const { xvfbNewWindows } = await import("../desktop-control");
		expect(xvfbNewWindows([], ["AeryAim2", "AeryBench"])).toEqual(["AeryAim2", "AeryBench"]);
	});

	test("drops a window that closed before the poll finished", async () => {
		const { xvfbNewWindows } = await import("../desktop-control");
		expect(xvfbNewWindows(["Gone"], [])).toEqual([]);
	});
});
