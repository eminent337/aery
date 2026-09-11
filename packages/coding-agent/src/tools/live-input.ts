/**
 * Live desktop input for Wayland/Hyprland — the Aery app-control port (D002/D004).
 *
 * Backends, in priority order:
 *  1. `ydotool`  — uinput-based, works on native Wayland AND XWayland (mouse+keyboard).
 *     Requires the `ydotoold` daemon and /dev/uinput access (udev rule, see
 *     study/notes/app-control-port-design.md).
 *  2. `wtype`    — wlroots virtual-keyboard protocol (keyboard/type only; no root).
 *  3. `xdotool`  — X11/XTest; only reaches XWayland windows under Hyprland.
 *
 * CLI contract grounded from ReimuNotMoe/ydotool v1 source (Client/tool_click.c,
 * Client/tool_key.c, README): `mousemove --absolute -x N -y N`, `click <hex>` where
 * low nibble 0=LEFT 1=RIGHT 2=MIDDLE and bit 0x40=down 0x80=up (0xC0 = left click,
 * 0x40 = left down, 0x80 = left up — so drag = down→move→up), `key <code>:<0|1>`,
 * `type <text>` (layout-aware). All functions here are PURE builders / probes; the
 * tool executes the returned argv lists with runCmd + inter-step sleeps.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** --- Backend probe ---------------------------------------------------- */

export interface BackendProbe {
	ydotool: boolean;
	ydotoold: boolean;
	xdotool: boolean;
	wtype: boolean;
}

async function hasBin(name: string): Promise<boolean> {
	try {
		const res = await execFileAsync("sh", ["-c", `command -v ${name}`], { timeout: 3000 });
		return res.stdout.trim().length > 0;
	} catch {
		return false;
	}
}

export async function probeBackends(): Promise<BackendProbe> {
	const [ydotool, xdotool, wtype] = await Promise.all([hasBin("ydotool"), hasBin("xdotool"), hasBin("wtype")]);
	// ydotoold (the daemon) exposes a unix socket; absent socket ⇒ no daemon.
	// Modern builds (e.g. Arch ydotool 1.0.4) put it at $XDG_RUNTIME_DIR/.ydotool_socket;
	// older builds used /tmp/.ydotool_socket. Probe both.
	const runtimeDir = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
	const ydotoold =
		ydotool &&
		(fs.existsSync("/tmp/.ydotool_socket") || (runtimeDir.length > 0 && fs.existsSync(`${runtimeDir}/.ydotool_socket`)));
	return { ydotool, ydotoold, xdotool, wtype };
}

/** What kind of device an input action needs. */
export type InputKind = "pointer" | "keyboard" | "type";

export type LiveBackend = "ydotool" | "wtype" | "xdotool";

/** Backend resolver — pure decision given probe + target window compositor. */
export function resolveBackend(
	probe: BackendProbe,
	windowXwayland: boolean | undefined,
	kind: InputKind,
): LiveBackend | "none" | "no-daemon" {
	if (probe.ydotool && probe.ydotoold) return "ydotool";
	if (probe.ydotool && !probe.ydotoold) return "no-daemon";
	// XWayland windows can be reached by xdotool (native Wayland windows cannot).
	if (windowXwayland && probe.xdotool) return "xdotool";
	if (kind !== "pointer" && probe.wtype) return "wtype";
	return "none";
}

/** --- Coordinate frame (TARS-style round-trip) ------------------------- */

/**
 * The model-visible frame is the last screenshot the tool returned: a window or the
 * full display, downscaled to ≤ maxWidth×maxHeight. Every live_* coordinate is given
 * in that frame; `frameToPhysical` maps it back to compositor pixel space.
 */
export interface InputFrame {
	kind: "window" | "fullscreen";
	atX: number;
	atY: number;
	/** Physical (raw capture) pixels. */
	physW: number;
	physH: number;
	/** Model-visible (downscaled) pixels. */
	scaledW: number;
	scaledH: number;
	/** hyprctl client address the frame was captured from (window frames only). */
	address?: string;
}

export function frameScaleX(frame: InputFrame): number {
	return frame.scaledW / frame.physW;
}

export function frameScaleY(frame: InputFrame): number {
	return frame.scaledH / frame.physH;
}

/** Map a click at frame-pixel (cx, cy) to compositor pixel space. */
export function frameToPhysical(frame: InputFrame, cx: number, cy: number): { x: number; y: number } {
	const sx = frameScaleX(frame);
	const sy = frameScaleY(frame);
	// Clamp into the frame first, then scale — the right/bottom edge maps exactly to physW/H.
	const fx = Math.min(Math.max(cx, 0), frame.scaledW);
	const fy = Math.min(Math.max(cy, 0), frame.scaledH);
	return {
		x: Math.round(frame.atX + fx / sx),
		y: Math.round(frame.atY + fy / sy),
	};
}

/** --- Keyboard spec → evdev keycodes (linux/input-event-codes.h) -------- */

const KEY: Record<string, number> = {
	escape: 1,
	esc: 1,
	"1": 2,
	"2": 3,
	"3": 4,
	"4": 5,
	"5": 6,
	"6": 7,
	"7": 8,
	"8": 9,
	"9": 10,
	"0": 11,
	"-": 12,
	"=": 13,
	backspace: 14,
	tab: 15,
	q: 16,
	w: 17,
	e: 18,
	r: 19,
	t: 20,
	y: 21,
	u: 22,
	i: 23,
	o: 24,
	p: 25,
	"[": 26,
	"]": 27,
	enter: 28,
	return: 28,
	a: 30,
	s: 31,
	d: 32,
	f: 33,
	g: 34,
	h: 35,
	j: 36,
	k: 37,
	l: 38,
	";": 39,
	"'": 40,
	"`": 41,
	"\\": 43,
	z: 44,
	x: 45,
	c: 46,
	v: 47,
	b: 48,
	n: 49,
	m: 50,
	",": 51,
	".": 52,
	"/": 53,
	space: 57,
	" ": 57,
	f1: 59,
	f2: 60,
	f3: 61,
	f4: 62,
	f5: 63,
	f6: 64,
	f7: 65,
	f8: 66,
	f9: 67,
	f10: 68,
	f11: 87,
	f12: 88,
	leftctrl: 29,
	ctrl: 29,
	control: 29,
	leftshift: 42,
	shift: 42,
	leftalt: 56,
	alt: 56,
	leftsuper: 125,
	super: 125,
	win: 125,
	meta: 125,
	mod4: 125,
	rightctrl: 97,
	rightshift: 54,
	rightalt: 100,
	rightsuper: 126,
	capslock: 58,
	numlock: 69,
	scrolllock: 70,
	home: 102,
	up: 103,
	pageup: 104,
	pgup: 104,
	left: 105,
	right: 106,
	end: 107,
	down: 108,
	pagedown: 109,
	pgdn: 109,
	insert: 110,
	delete: 111,
};

/** Parse one chord token (`Return`, `ctrl+l`, `ctrl+shift+t`) → keycodes in order. */
export function parseChord(token: string): number[] | undefined {
	const parts = token.toLowerCase().split("+");
	const codes: number[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) return undefined;
		const code = KEY[trimmed];
		if (code === undefined) return undefined;
		codes.push(code);
	}
	return codes.length > 0 ? codes : undefined;
}

/** Expand a `keys` spec into evdev events (`<code>:<0|1>`) for `ydotool key`. */
export function specToYdotoolEvents(spec: string): string[] | { error: string } {
	const events: string[] = [];
	const tokens = spec.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { error: "keys spec is empty" };
	for (const token of tokens) {
		const codes = parseChord(token);
		if (!codes)
			return {
				error: `unknown key token "${token}" (known names: Return, Tab, space, ctrl+l, super+Return, F1-F12, arrows, Home/End/Page_Up/Page_Down…)`,
			};
		// Press in order; release in reverse so modifier chords stay clean.
		for (const c of codes) events.push(`${c}:1`);
		for (let i = codes.length - 1; i >= 0; i--) events.push(`${codes[i]}:0`);
	}
	return events;
}

/** Map a canonical token to an xdotool/wtype keysym name (X11 / wlroots path). */
export function toXdotoolKeyName(token: string): string | undefined {
	const t = token.toLowerCase();
	const simple: Record<string, string> = {
		return: "Return",
		enter: "Return",
		tab: "Tab",
		space: "space",
		escape: "Escape",
		esc: "Escape",
		backspace: "BackSpace",
		delete: "Delete",
		insert: "Insert",
		home: "Home",
		end: "End",
		up: "Up",
		down: "Down",
		left: "Left",
		right: "Right",
		pageup: "Page_Up",
		pgup: "Page_Up",
		pagedown: "Page_Down",
		pgdn: "Page_Down",
		ctrl: "ctrl",
		control: "ctrl",
		alt: "alt",
		shift: "shift",
		super: "Super_L",
		win: "Super_L",
		meta: "Super_L",
	};
	if (simple[t]) return simple[t];
	if (/^f([1-9]|1[0-2])$/.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
	// xdotool/wtype use lowercase keysyms for letters and plain digits for numbers.
	if (/^[a-z0-9]$/.test(t)) return t;
	return undefined;
}

export function specToXdotoolArgs(spec: string): string[] | { error: string } {
	const tokens = spec.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { error: "keys spec is empty" };
	const names: string[] = [];
	for (const token of tokens) {
		const parts = token.toLowerCase().split("+");
		const mapped: string[] = [];
		for (const p of parts) {
			const name = toXdotoolKeyName(p.trim());
			if (!name) return { error: `unknown key token "${token}"` };
			mapped.push(name);
		}
		names.push(mapped.join("+"));
	}
	return names;
}

/** --- Text typing policy ---------------------------------------------- */

/** Chars ydotool `type` can emit layout-dependently with high confidence. */
export function isDirectTypeable(text: string): boolean {
	// ASCII printable except newline (newline needs an Enter keypress) is direct;
	// everything else goes through the clipboard (wl-copy) + Ctrl+V paste path.
	// Empty text is trivially typeable (no-op).
	return text.length === 0 || /^[\x20-\x7e]+$/.test(text);
}

/** Split text on newlines so each chunk can be typed + Enter pressed between. */
export function splitForEnterTyping(text: string): string[] {
	return text.replace(/\r\n/g, "\n").split("\n");
}

/** --- Command builders -------------------------------------------------
 * Each function returns an ordered list of argv arrays (no shell). The tool runs
 * them sequentially with runCmd and a short settle between consecutive steps.
 */

export const YDO_LEFT = "0xC0";
export const YDO_RIGHT = "0xC1";
export const YDO_MIDDLE = "0xC2";
export const YDO_DOWN = "0x40"; // left button down (bit 0x40)
export const YDO_UP = "0x80"; // left button up (bit 0x80)
export const YDO_CTRL_V = ["29:1", "47:1", "47:0", "29:0"]; // Ctrl+V chord

export function ydoMove(x: number, y: number): string[] {
	return ["ydotool", "mousemove", "--absolute", "-x", String(Math.round(x)), "-y", String(Math.round(y))];
}

export function ydoClickButton(code: string, count = 1): string[] {
	const argv = ["ydotool", "click"];
	if (count > 1) argv.push("--repeat", String(Math.min(count, 20)), "--next-delay", "80");
	argv.push(code);
	return argv;
}

export function ydoKeyEvents(events: string[]): string[] {
	return ["ydotool", "key", "-d", "24", ...events];
}

/** xdotool (XWayland) builders. */
export function xdoMove(x: number, y: number): string[] {
	return ["xdotool", "mousemove", "--sync", String(Math.round(x)), String(Math.round(y))];
}
/** Exact pointer warp via the compositor (Hyprland). ydotool's virtual device has no
 * ABS_X/ABS_Y capability — "absolute" moves are relative-delta accumulations that
 * pointer-accel skew, so never use them to aim; position with movecursor, inject
 * buttons/keys with ydotool. */
export function hyprMoveCursor(x: number, y: number): string[] {
	return ["hyprctl", "dispatch", "movecursor", String(Math.round(x)), String(Math.round(y))];
}

export function xdoClick(x: number, y: number, button: "left" | "right" | "middle", count = 1): string[] {
	const btn = button === "left" ? "1" : button === "right" ? "3" : "2";
	const argv = ["xdotool", "mousemove", "--sync", String(Math.round(x)), String(Math.round(y)), "click"];
	if (count > 1) argv.push("--repeat", String(Math.min(count, 20)), "--delay", "80");
	argv.push(btn);
	return argv;
}

export function xdoDrag(x1: number, y1: number, x2: number, y2: number): string[] {
	return [
		"xdotool",
		"mousemove",
		"--sync",
		String(Math.round(x1)),
		String(Math.round(y1)),
		"mousedown",
		"1",
		"mousemove",
		"--sync",
		String(Math.round(x2)),
		String(Math.round(y2)),
		"mouseup",
		"1",
	];
}

export function xdoType(text: string, delayMs = 40): string[] {
	return ["xdotool", "type", "--delay", String(delayMs), text];
}

/** wtype (wlroots virtual keyboard) builders — keyboard/type only. */
export function wtypeChord(token: string): { argv: string[]; ok: true } | { error: string } {
	const parts = token.toLowerCase().split("+");
	const keys: string[] = [];
	const mods: string[] = [];
	const modMap: Record<string, string> = {
		ctrl: "ctrl",
		control: "ctrl",
		alt: "alt",
		shift: "shift",
		super: "super",
		win: "super",
		meta: "super",
	};
	for (const p of parts) {
		const t = p.trim();
		if (modMap[t]) {
			mods.push(modMap[t]);
			continue;
		}
		const name = toXdotoolKeyName(t);
		if (!name) return { error: `wtype cannot emit key "${t}"` };
		keys.push(name);
	}
	if (keys.length !== 1) return { error: `wtype expects one key per chord (got "${token}")` };
	const argv = ["wtype"];
	for (const m of mods) argv.push("-M", m);
	argv.push("-k", keys[0]);
	for (const m of mods) argv.push("-m", m);
	return { argv, ok: true };
}

export function wtypeText(text: string): string[] {
	return ["wtype", text];
}
