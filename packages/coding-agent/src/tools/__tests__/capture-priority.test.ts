import { afterEach, describe, expect, test } from "bun:test";

import {
	captureExecPlan,
	execFileNiced,
	glideCaptureNice,
	setGlideCaptureNice,
	shouldNiceCapture,
} from "../capture-priority";

/** Pins for capture-priority: the glide-time niceness that keeps hop cadence
 *  16ms instead of 78ms under concurrent capture load (root cause: our own
 *  convert/tesseract/grim children starving the compositor — see module doc).
 *  The plan is pure (nice argv wrapper — Bun has no process.setpriority);
 *  execFileNiced smoke-pins that the wrapper preserves output and errors. */

afterEach(() => setGlideCaptureNice(false));

describe("glide capture nice toggle", () => {
	test("arms to 15 and disarms to 0", () => {
		expect(glideCaptureNice()).toBe(0);
		setGlideCaptureNice(true);
		expect(glideCaptureNice()).toBe(15);
		setGlideCaptureNice(false);
		expect(glideCaptureNice()).toBe(0);
	});
});

describe("shouldNiceCapture allowlist", () => {
	test("observation binaries yield during a glide", () => {
		for (const cmd of ["grim", "convert", "identify", "tesseract", "magick"]) {
			expect(shouldNiceCapture(cmd, [])).toBe(true);
		}
		expect(shouldNiceCapture("hyprctl", ["activewindow", "-j"])).toBe(true);
		expect(shouldNiceCapture("hyprctl", ["cursorpos", "-j"])).toBe(true);
		expect(shouldNiceCapture("hyprctl", ["monitors"])).toBe(true);
		expect(shouldNiceCapture("/usr/bin/grim", ["-c", "/tmp/x.png"])).toBe(true);
	});

	test("input injection and window dispatches never lose priority", () => {
		expect(shouldNiceCapture("ydotool", ["move", "1", "2"])).toBe(false);
		expect(shouldNiceCapture("xdotool", ["mousemove", "1", "2"])).toBe(false);
		expect(shouldNiceCapture("wtype", ["hello"])).toBe(false);
		expect(shouldNiceCapture("hyprctl", ["dispatch", "movecursor", "1", "2"])).toBe(false);
		expect(shouldNiceCapture("sh", ["-c", "whatever"])).toBe(false);
	});
});

describe("captureExecPlan (nice argv wrapper decision)", () => {
	test("disarmed: everything passes through untouched", () => {
		expect(captureExecPlan("convert", ["a.png", "b.png"])).toEqual({ bin: "convert", args: ["a.png", "b.png"] });
		expect(captureExecPlan("tesseract", ["img", "stdout"])).toEqual({ bin: "tesseract", args: ["img", "stdout"] });
	});

	test("armed: capture work wraps in nice -n 15, argv preserved", () => {
		setGlideCaptureNice(true);
		expect(captureExecPlan("convert", ["-resize", "900x700!", "/tmp/x.png"])).toEqual({
			bin: "nice",
			args: ["-n", "15", "convert", "-resize", "900x700!", "/tmp/x.png"],
		});
		expect(captureExecPlan("hyprctl", ["activewindow", "-j"])).toEqual({
			bin: "nice",
			args: ["-n", "15", "hyprctl", "activewindow", "-j"],
		});
	});

	test("armed: input injection and dispatches stay at full priority", () => {
		setGlideCaptureNice(true);
		expect(captureExecPlan("ydotool", ["move", "1", "2"])).toEqual({ bin: "ydotool", args: ["move", "1", "2"] });
		expect(captureExecPlan("hyprctl", ["dispatch", "movecursor", "1", "2"])).toEqual({
			bin: "hyprctl",
			args: ["dispatch", "movecursor", "1", "2"],
		});
	});
});

describe("execFileNiced (drop-in promisified execFile)", () => {
	test("resolves text output like execFileAsync did", async () => {
		const r = await execFileNiced("sh", ["-c", "echo hello-there"]);
		expect(r.stdout.trim()).toBe("hello-there");
	});

	test("rejects with code and captured stdout/stderr preserved", async () => {
		expect.assertions(3);
		try {
			await execFileNiced("sh", ["-c", "echo out; echo err >&2; exit 3"]);
		} catch (e) {
			const err = e as { code?: number; stdout?: string; stderr?: string };
			expect(err.code).toBe(3);
			expect(String(err.stdout)).toContain("out");
			expect(String(err.stderr)).toContain("err");
		}
	});

	test("armed: the nice wrapper executes capture commands successfully", async () => {
		setGlideCaptureNice(true);
		// convert is allowlisted → plan wraps in `nice`; output must be intact.
		const r = await execFileNiced("convert", ["-version"]);
		expect(r.stdout).toContain("ImageMagick");
	}, 30000);
});
