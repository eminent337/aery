import { describe, expect, test } from "bun:test";
import { xvfbAuthPromptHint } from "../desktop-control";

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

describe("buildXvfbTypeArgs / buildXvfbKeyArgs (focus before input)", () => {
	test("type argv focuses the window first (windowfocus works without a WM), then types", async () => {
		const { buildXvfbTypeArgs } = await import("../desktop-control");
		expect(buildXvfbTypeArgs("hello world", "0x1234")).toEqual([
			"windowfocus",
			"--sync",
			"0x1234",
			"type",
			"--delay",
			"40",
			"hello world",
		]);
	});

	test("key argv focuses the window first, then sends keys", async () => {
		const { buildXvfbKeyArgs } = await import("../desktop-control");
		expect(buildXvfbKeyArgs("Return", "0x1234")).toEqual(["windowfocus", "--sync", "0x1234", "key", "Return"]);
	});

	test("omits focusing when no window id is known", async () => {
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

describe("xvfbTargetsAreCurrent (frame/target generation binding)", () => {
	const FRAME = { physW: 1600, physH: 900, scaledW: 1280, scaledH: 720 };

	test("targets are current right after a reading that produced them", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets(
			[{ text: "B2", x: 271, y: 328, w: 57, h: 38, confidence: 0.93 }],
		);
		expect(m.xvfbTargetsAreCurrent()).toBe(true);
	});

	test("an ocr:false pass invalidates remembered targets", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets([
			{ text: "B2", x: 271, y: 328, w: 57, h: 38, confidence: 0.93 },
		]);
		// An ocr:false screenshot records NO targets for its new generation.
		m.rememberXvfbTargets([]);
		expect(m.xvfbTargetsAreCurrent()).toBe(false);
		// Fail closed: resolve must not hand out a stale box.
		expect(m.resolveXvfbTarget("B2")).toBeNull();
	});

	test("a resized reading invalidates targets from the old frame", async () => {
		const m = await import("../desktop-control");
		m.rememberXvfbTargets(
			[{ text: "B2", x: 271, y: 328, w: 57, h: 38, confidence: 0.93 }],
		);
		// A capped 640-wide reading owns neither these boxes nor this frame.
		m.rememberXvfbTargets([]);
		expect(m.xvfbTargetsAreCurrent()).toBe(false);
		expect(m.resolveXvfbTarget("B2")).toBeNull();
	});
});

describe("xvfbDragScript (held-drag batch choreography)", () => {
	test("keeps the button down for the whole sweep — approach, press, travel, dwell, release", async () => {
		const m = await import("../desktop-control");
		const script = m.xvfbDragScript(
			[{ x: 100, y: 100, waitMs: 10 }],
			[
				{ x: 300, y: 200, waitMs: 15 },
				{ x: 400, y: 220, waitMs: 18 },
			],
			{ button: "1", settleMs: 120, pressHoldMs: 80, endHoldMs: 120, afterMs: 80 },
		);
		const lines = script.trim().split("\n");
		// Approach, settle, press + hold.
		expect(lines[0]).toBe("mousemove --sync 100 100");
		expect(lines).toContain("sleep 0.120");
		expect(lines).toContain("mousedown 1");
		expect(lines).toContain("sleep 0.080");
		// The sweep travels with the button still down: no mouseup before
		// the last travel step, and exactly one release after the dwell.
		const downIdx = lines.indexOf("mousedown 1");
		const upIdx = lines.indexOf("mouseup 1");
		expect(upIdx).toBeGreaterThan(downIdx);
		expect(lines.filter(l => l === "mouseup 1")).toHaveLength(1);
		expect(lines.filter(l => l === "mousedown 1")).toHaveLength(1);
		const sweepIdx = lines.findIndex(l => l === "mousemove --sync 400 220");
		expect(sweepIdx).toBeGreaterThan(downIdx);
		expect(sweepIdx).toBeLessThan(upIdx);
		expect(lines[upIdx - 1]).toBe("sleep 0.120");
		expect(lines[upIdx + 1]).toBe("sleep 0.080");
	});

	test("an empty approach still presses at the sweep start", async () => {
		const m = await import("../desktop-control");
		const script = m.xvfbDragScript([], [{ x: 400, y: 220, waitMs: 18 }], {
			button: "1",
			settleMs: 120,
			pressHoldMs: 80,
			endHoldMs: 120,
			afterMs: 80,
		});
		const lines = script.trim().split("\n");
		expect(lines).toContain("mousedown 1");
		expect(lines.indexOf("mousedown 1")).toBeLessThan(lines.indexOf("mousemove --sync 400 220"));
	});

	test("holds and releases the SAME button it was told to drag", async () => {
		const m = await import("../desktop-control");
		const script = m.xvfbDragScript([{ x: 100, y: 100, waitMs: 10 }], [{ x: 400, y: 220, waitMs: 18 }], {
			button: "3",
			settleMs: 120,
			pressHoldMs: 80,
			endHoldMs: 120,
			afterMs: 80,
		});
		const lines = script.trim().split("\n");
		expect(lines).toContain("mousedown 3");
		expect(lines).toContain("mouseup 3");
		expect(lines.filter(l => /^mouse(up|down) /.test(l))).toHaveLength(2);
	});
});


describe("xvfbAuthPromptHint (credential-prompt detection)", () => {
	const cases: Array<[string, string | null]> = [
		["[sudo] password for aryee:", "sudo password"],
		["Password: ", "password prompt"],
		["Enter passphrase for key '/home/aryee/.ssh/id_ed25519':", "passphrase"],
		["Enter password: ", "password entry"],
		["Authentication required", "authentication required"],
		["Enter your PIN:", "PIN entry"],
		["Two-factor authentication code:", "2FA / verification code"],
		["Verification code: ", "2FA / verification code"],
		["bash-5.3$ ls -la", null],
		["File saved successfully.", null],
		["", null],
		["user@host's password:", "ssh password"],
	];
	for (const [text, want] of cases) {
		test(`${JSON.stringify(text)} → ${want}`, () => {
			const got = xvfbAuthPromptHint(text || undefined);
			if (want === null) expect(got).toBeNull();
			else expect(got).toBe(want);
		});
	}
});

describe("xvfbAuthPromptHint — real OCR output shapes", () => {
	test("detects a prompt with a trailing cursor glyph (dark-theme OCR)", () => {
		expect(xvfbAuthPromptHint("bash-5.3$ bash /tmp/auth-fixture.sh\nPassword: ||")).toBe("password prompt");
	});
	test("a clean shell transcript is not a prompt", () => {
		expect(xvfbAuthPromptHint("bash-5.3$ echo hi\nhi\nbash-5.3$")).toBeNull();
	});
});
