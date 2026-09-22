import { CameraWatchLoop } from "./camera-control";
import { ObservationController, type ObservationSnapshot, type WindowRect } from "./live-observe";
import { detectOutputScale, detectPlatformDriver, detectReservedArea, physicalToLogical } from "./desktop-drivers";
import { buildEyeGeometry, describeEyeTarget, type EyeRegion } from "./live-eye";
import { type OcrWordBox, ocrFrame } from "./screen-ocr";
import { formatScrollReadDigest, normalizeOcrConfidence, scrollFrameQuality } from "./scroll-reading";
import {
	boundingBox,
	frameRectToPhysical,
	highlightColor,
	highlightOverlayScript,
	layerGeometry,
	mergeBands,
	toBands,
	type FrameRect,
	type HighlightRect,
} from "./eye-highlight";
/**
 * Desktop Control & Screen Vision Tool.
 *
 * Provides desktop window awareness, screen capture, DPI-aware scaling,
 * window focus/lifecycle, and workspace management.
 *
 * Cross-platform (ferment D001): every OS/compositor-specific call lives in
 * the DesktopDriver behind detectPlatformDriver() (Hyprland native via grim
 * & hyprctl; X11 via import/scrot & xdotool; macOS/Windows report honest
 * capability gaps until implemented). Everything above the driver — verify
 * steers, fallback chains, preAuthorize, frame math — is driver-agnostic.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@aryee337/aery-core";
import * as z from "zod/v4";
import desktopControlDescription from "../prompts/tools/desktop-control.md" with { type: "text" };
import type { ToolSession } from "./index";
import {
	frameToPhysical,
	hyprMoveCursor,
	type InputFrame,
	type InputKind,
	isDirectTypeable,
	ensureYdotoold,
	type LiveBackend,
	probeBackends,
	resolveBackendChain,
	resolveBackend,
	specToXdotoolArgs,
	specToYdotoolEvents,
	splitForEnterTyping,
	wtypeChord,
	xdoClick,
	xdoMove,
	xdoWheelScroll,
	YDO_CTRL_V,
	YDO_DOWN,
	YDO_LEFT,
	YDO_MIDDLE,
	YDO_RIGHT,
	YDO_UP,
	ydoClickButton,
	ydoKeyEvents,
	ydoMove,
	ydoPageScroll,
	ydoMoveRelative,
} from "./live-input";
import {
	CLICK_CHOREOGRAPHY,
	clickPath,
	DEFAULT_MOTION_CONFIG,
	DRAG_CHOREOGRAPHY,
	dragPath,
	type MotionStep,
	windMousePath,
} from "./mouse-motion";

const execFileAsync = promisify(execFile);
export interface DesktopWindowInfo {
	address: string;
	title: string;
	class: string;
	workspace: number | string;
	at: [number, number];
	size: [number, number];
	focused: boolean;
	pid?: number;
	/** true when the client is an XWayland app (matters for input backend choice). */
	xwayland?: boolean;
}

export interface ScreenshotResultDetails {
	filePath: string;
	physicalDimensions: { width: number; height: number };
	scaledDimensions?: { width: number; height: number };
	target: string;
	targetWindow?: { title: string; class: string; address: string };
	ocrText?: string;
	ocrMode?: "native" | "upscaled";
	ocrMs?: number;
	ocrError?: string;
}

const desktopControlSchema = z.object({
	action: z
		.enum([
			"screenshot",
			"list_windows",
			"live_eye",
			"highlight",
			"focus_window",
			"close_window",
			"switch_workspace",
			"launch_app",
			"cursor_pos",
			"live_mode_on",
			"live_mode_off",
			"live_mode_status",
			"live_backend_probe",
			"live_move",
			"live_click",
			"live_drag",
			"live_type",
			"live_key",
			"live_scroll",
			"system_control",
			"xvfb_launch",
			"xvfb_screenshot",
			"xvfb_list_windows",
			"xvfb_click",
			"xvfb_drag",
			"xvfb_type",
			"xvfb_key",
			"xvfb_project",
			"xvfb_close",
		])
		.describe(
			"Actions: 'live_eye' is your own eyes, exactly like a human's — look whenever you want to look, any time, any reason, no permission needed. A fast sub-second glance at the environment: active window, fullscreen, a window by name, or a physical-pixel region. The glance attaches to your context as a hidden reading — OCR text on every visionless model, pixels + OCR on vision-capable models — and never renders in the transcript. Eye views are ephemeral: each glance sweeps the previous one from context, so glance freely and as often as you want. Other actions: 'screenshot' captures display/window and returns the frame inline in the result (visible), 'list_windows' lists open GUI apps, 'focus_window' brings app to front, 'close_window' closes a window, 'switch_workspace' changes workspace, 'launch_app' spawns a VISIBLE app on the desktop, 'cursor_pos' gets mouse coordinates, 'system_control' controls volume/media/brightness/lock/web search. Headless (invisible virtual display): 'xvfb_launch' runs a desktop app invisibly, 'xvfb_screenshot' captures its UI, 'xvfb_list_windows' lists windows on the virtual display, 'xvfb_click'/'xvfb_type'/'xvfb_key' drive the app, 'xvfb_project' streams that headless display onto the real desktop so the USER can watch and TYPE INTO it (use when a step needs them — a password, sudo, a passphrase, 2FA), 'xvfb_close' ends it all. LIVE app-control on the real desktop (opt-in via 'live_mode_on'): 'live_move'/'live_click'/'live_drag'/'live_type'/'live_key'/'live_scroll' inject input into the FOCUSED window. Use 'live_mode_off' to disable.",
		),
	region: z
		.object({
			x: z.number().int().min(0).describe("Physical-screen X (top-left of crop)."),
			y: z.number().int().min(0).describe("Physical-screen Y (top-left of crop)."),
			w: z.number().int().min(1).describe("Crop width in physical px."),
			h: z.number().int().min(1).describe("Crop height in physical px."),
		})
		.optional()
		.describe(
			"Physical-pixel rectangle for 'live_eye' — a crop of the ENTIRE desktop, independent of any window. The eye looks anywhere.",
		),
	views: z
		.array(
			z
				.object({
					target: z
						.string()
						.optional()
						.describe("What to look at: 'fullscreen' (default), 'active_window', or a window title/class/address substring."),
					region: z
						.object({
							x: z.number().int().min(0),
							y: z.number().int().min(0),
							w: z.number().int().min(1),
							h: z.number().int().min(1),
						})
						.optional()
						.describe("Physical-pixel crop of the ENTIRE desktop for this view (like top-level region)."),
					label: z
						.string()
						.optional()
						.describe("Short label for the reading header, e.g. 'fovea', 'tab strip', 'second monitor'."),
				})
				.refine(v => v.target || v.region, { message: "each view needs 'target' or 'region'" }),
		)
		.max(4)
		.optional()
		.describe(
			"Multi-focus glance: 1-4 views in ONE call, like a human eye saccading between focus points while keeping the whole scene — e.g. [{target:'active_window'},{region:{x:0,y:0,w:600,h:400},label:'fovea'}] returns wide context + zoomed focus together. Each view gets its own anchored frame and clickable words; all readings arrive in one hidden steer. Views capture concurrently, so 2-4 views cost little more than one.",
		),
	command: z
		.string()
		.optional()
		.describe(
			"Application command or desktop binary to run for 'launch_app' or 'xvfb_launch' (e.g. 'brave', 'code', 'pavucontrol'). For 'xvfb_launch' you may append args and a URL (e.g. 'flatpak run com.brave.Browser https://example.com').",
		),
	url: z.string().optional().describe("URL to open with the app for 'xvfb_launch' (appended to command)."),
	x: z
		.number()
		.int()
		.optional()
		.describe(
			"X pixel coordinate — 'xvfb_click'/'xvfb_drag' frame (virtual display origin top-left) or 'live_click'/'live_drag'/'live_move' model-visible screenshot frame px. For 'xvfb_drag' this is the press (start) point.",
		),
	y: z.number().int().optional().describe("Y pixel coordinate — see 'x'."),
	x2: z.number().int().optional().describe("End X pixel coordinate for 'live_drag' (same frame as 'x') or 'xvfb_drag' (same frame as 'x' — the release point)."),
	y2: z.number().int().optional().describe("End Y pixel coordinate — see 'x2'."),
	target2: z
		.string()
		.optional()
		.describe("Optional end-anchor word for 'xvfb_drag' (resolved like 'target'); when present with 'target', drags word-to-word. Without it, 'target'+x2/y2 drags word-to-point."),
	modifiers: z
		.array(z.enum(["shift"]))
		.max(1)
		.optional()
		.refine(modifiers => modifiers === undefined || modifiers.length > 0, {
			message: "modifiers must contain 'shift' when present; use undefined for no modifiers.",
		})
		.describe("For 'live_drag' only: optional ['shift'] holds Shift before mouse down until after mouse up. Runtime rejects this field on every other action, including empty lists, before anything touches the desktop. No other modifiers or actions are supported."),
	keys: z
		.string()
		.optional()
		.describe(
			"Text for 'xvfb_type'/'live_type' (literal text, newlines become Enter) or key spec for 'xvfb_key'/'live_key' (names like Return, Tab, ctrl+l, super+Return, space; multiple separated by spaces).",
		),
	button: z
		.enum(["left", "right", "middle"])
		.optional()
		.describe("Mouse button for 'live_click'/'live_drag'/'xvfb_click'/'xvfb_drag' (default: left)."),
	count: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe("Repeat count: 'live_click' double-click = 2; 'live_scroll' = wheel/Page steps (default: 1)."),
	target: z
		.string()
		.optional()
		.describe(
			"Target selector, meaning depends on action: for 'live_click'/'live_move' it is click-target text matched against an OCR word from the last eye/screenshot (e.g. \"Compose\", \"Send\") and resolved to that word's frame-px center instead of raw x/y; for 'xvfb_click'/'xvfb_drag' it is a word from the last xvfb_screenshot reading ('target2' is the optional end anchor for 'xvfb_drag'); for 'live_eye'/'screenshot' it is what to look at ('fullscreen' — default for the eye — 'active_window', or a substring of a window title/class).",
		),
	direction: z
		.enum(["up", "down"])
		.optional()
		.describe(
			"Scroll direction for 'live_scroll' (default: down). Native Wayland wheel needs uinput REL_WHEEL which ydotool does not expose — 'live_scroll' on a native window emulates Page_Up/Page_Down.",
		),
	scrollSpeed: z
		.enum(["slow", "normal", "fast"])
		.optional()
		.describe(
			"Reading cadence for a 'live_scroll' burst (default: normal). Sets the inter-step pause so the eye can read while the view moves: slow ≈600ms for reading along, normal ≈250ms, fast ≈80ms for covering ground. Each step still re-checks the exact focused-window address before injecting.",
		),
	observeDuringScroll: z
		.boolean()
		.optional()
		.describe(
			"Sample a cheap change fingerprint between 'live_scroll' steps and report per-step progress in details.scroll.samples (default: true). No full settle wait is forced between steps; the burst keeps moving while observations stream.",
		),
	verify: z
		.boolean()
		.optional()
		.describe(
			"Take a follow-up screenshot after the live action (default: true) so the model self-corrects. The capture is delivered to the model as a hidden attachment (OCR text for visionless models, pixels+OCR for vision-capable ones) — the visible tool result stays a one-liner. Set false to skip the extra capture.",
		),
	preAuthorize: z
		.array(z.enum(["live_move", "live_click", "live_drag", "live_type", "live_key", "live_scroll"]))
		.optional()
		.describe(
			"For 'live_mode_on': pre-authorize these live input kinds NOW (skip the first-use approval prompt for them this session). Use when you know the automation flow ahead (e.g. [\"live_click\",\"live_type\",\"live_key\"]) so multi-step app driving doesn't deadlock on a mid-flow prompt. Only these six injection kinds are accepted.",
		),
	query: z.string().optional().describe("Window address, title, or class query for 'focus_window' or 'close_window'."),
	mode: z
		.enum(["start", "stop", "status"])
		.optional()
		.describe(
			"For 'xvfb_project': 'start' (default) begins projecting the headless display to the real desktop; 'stop' ends it; 'status' reports whether a projection is live.",
		),
	workspace: z.string().optional().describe("Workspace identifier for 'switch_workspace' (e.g. '1', '2', 'special')."),
	subAction: z
		.enum([
			"volume_up",
			"volume_down",
			"set_volume",
			"mute",
			"unmute",
			"play_pause",
			"next_track",
			"prev_track",
			"lock_screen",
			"set_brightness",
			"web_search",
		])
		.optional()
		.describe("Sub-action for 'system_control'."),
	value: z.number().optional().describe("Numeric value for volume (0-100) or brightness (0-100)."),
	platform: z
		.enum(["google", "youtube", "github", "reddit", "stackoverflow", "wikipedia"])
		.optional()
		.describe("Search platform for 'web_search' sub-action (default: google)."),
	maxWidth: z.number().int().optional().describe("Max pixel width for vision downscaling (default: 1280)."),
	maxHeight: z.number().int().optional().describe("Max pixel height for vision downscaling (default: 800)."),
	includeBase64: z
		.boolean()
		.optional()
		.describe("Whether to return base64 encoded image in result for inline model vision (default: true)."),
	ocr: z
		.boolean()
		.optional()
		.describe(
			"Extract on-screen text with tesseract OCR and attach it as the hidden reading (text-only on visionless models, alongside pixels on vision-capable ones). Defaults to true when the active model cannot see images, false otherwise. Pass false explicitly to skip the ~0.3-2s OCR cost (visionless models then get no reading).",
		),
	ocrLang: z
		.string()
		.optional()
		.describe("Tesseract language for 'ocr' (default: 'eng'; requires the language pack in /usr/share/tessdata)."),
	textOnly: z
		.boolean()
		.optional()
		.describe(
			"For 'live_eye': skip the base64 image read entirely and return OCR text + clickTargets only (child-process drives read words, not pixels). Cuts ~100-300ms of PNG read/encode per glance.",
		),
	highlight: z
		.object({
			targets: z
				.array(z.string())
				.optional()
				.describe("Words from the last eye/screenshot reading to highlight (resolved like live_click target)."),
			regions: z
				.array(
					z.object({
						x: z.number().int().min(0).describe("Frame px left."),
						y: z.number().int().min(0).describe("Frame px top."),
						w: z.number().int().min(1).describe("Frame px width."),
						h: z.number().int().min(1).describe("Frame px height."),
					}),
				)
				.optional()
				.describe("Raw frame-px rectangles to highlight (from the last reading's frames)."),
			color: z.enum(["yellow", "amber", "green", "cyan", "pink", "blue", "red"]).optional().describe("Marker color (default yellow — the classic highlighter)."),
			style: z
				.enum(["highlighter", "box"])
				.optional()
				.describe("highlighter (default) = solid translucent band painted over the words, like a felt-tip or a text selection. box = hollow outline around the region."),
			ms: z.number().int().min(300).max(30000).optional().describe("How long the mark stays before it dissolves, in ms (default 3000)."),
			width: z.number().int().min(1).max(20).optional().describe("Line width in px for style=box (default 4)."),
		})
		.optional()
		.describe(
			"For 'highlight': what to point at — the eye's laser pointer. Words resolved from the last reading's click targets, or raw frame-px regions. Painted on a click-through overlay that dissolves after `ms` (highlighter band by default, or a box outline).",
		),
})
	.superRefine((params, ctx) => {
		if (params.action !== "live_drag" && params.modifiers !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["modifiers"],
				message: "modifiers is supported only for live_drag.",
			});
		}
	});

export type DesktopControlParams = z.infer<typeof desktopControlSchema>;

async function runCmd(
	cmd: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			env: { ...process.env, ...options.env },
			timeout: options.timeout ?? 10_000,
		});
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; code?: number; message: string };
		return {
			stdout: error.stdout?.trim() || "",
			stderr: error.stderr?.trim() || error.message,
			code: error.code ?? 1,
		};
	}
}

/** True on the actively-supported desktop drivers (hyprland native, x11). */
function isSupportedDriver(): boolean {
	const id = detectPlatformDriver().id;
	return id === "hyprland" || id === "x11";
}

/** ---------- Headless desktop apps (Xvfb virtual display) ----------
 * Runs GUI apps into an invisible virtual X display. Everything the agent
 * needs is baked in: the display stays up across calls, Wayland-native apps
 * are forced onto the virtual X server (ozone/GTK env), and interactions go
 * through xdotool. Requires xorg-server-xvfb + xdotool (pacman).
 */
const XVFB_DISPLAY = ":99";
const XVFB_GEOMETRY = "1600x900x24";

/** Physical geometry of the virtual display, parsed from XVFB_GEOMETRY. */
function xvfbGeometry(): [number, number] {
	const [w, h] = XVFB_GEOMETRY.split("x");
	return [Number(w) || 1600, Number(h) || 900];
}

/** True once a probe has proven the Xvfb server is up. Memoized so repeated
 *  calls in one drive loop stop re-probing the display; cleared by
 *  xvfb_close so a later launch re-starts and re-proves it. */
let xvfbServerAlive = false;
function xvfbEnv(): NodeJS.ProcessEnv {
	return {
		DISPLAY: XVFB_DISPLAY,
		XDG_SESSION_TYPE: "x11",
		GDK_BACKEND: "x11",
		QT_QPA_PLATFORM: "xcb",
		// strip Wayland so apps cannot escape to the real desktop
		WAYLAND_DISPLAY: "",
		WAYLAND_SOCKET: "",
	};
}

async function xvfbEnsureServer(): Promise<void> {
	if (xvfbServerAlive) return;
	const probe = await runCmd("sh", ["-c", `DISPLAY=${XVFB_DISPLAY} xdotool getdisplaygeometry`]);
	if (probe.code === 0) {
		xvfbServerAlive = true;
		return;
	}
	const up = await runCmd("sh", [
		"-c",
		`nohup Xvfb ${XVFB_DISPLAY} -screen 0 ${XVFB_GEOMETRY} >/dev/null 2>&1 & sleep 1.5`,
	]);
	if (up.code !== 0) throw new Error(`Failed to start Xvfb: ${up.stderr}`);
	const check = await runCmd("sh", ["-c", `DISPLAY=${XVFB_DISPLAY} xdotool getdisplaygeometry`]);
	if (check.code !== 0) throw new Error("Xvfb started but not responding");
	xvfbServerAlive = true;
}

/**
 * ---------- Live projection to the real desktop (xvfb_project) ----------
 * Streams the headless Xvfb display (or one of its windows) to the user's REAL
 * desktop via xvfb-mirror.py, and forwards the user's mouse/keyboard back into
 * the headless session. The point: the user can SEE what the agent is doing
 * and TYPE INTO the headless app themselves — including secrets (passwords,
 * passphrases) the agent must never read. The agent verifies success only from
 * the app's own state, never from the secret.
 *
 * One projection at a time. Stopped by xvfb_project stop and by xvfb_close.
 */
let xvfbMirrorProc: { pid: number; log: string } | null = null;
const XVFB_MIRROR_TITLE = "AERY headless LIVE";

/** Resolve the xvfb-mirror.py asset path (shipped next to this file). */
function xvfbMirrorScript(): string {
	return path.join(import.meta.dirname ?? "", "xvfb-mirror.py");
}

/** True when the tracked mirror process is still alive. */
function xvfbMirrorAlive(): boolean {
	if (!xvfbMirrorProc) return false;
	try {
		process.kill(xvfbMirrorProc.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Last STAT line from the mirror log (frames + forwarded inputs). */
async function xvfbMirrorStat(): Promise<string> {
	if (!xvfbMirrorProc) return "no projection";
	try {
		const raw = fs.readFileSync(xvfbMirrorProc.log, "utf-8");
		const lines = raw.split("\n").filter(l => l.startsWith("STAT"));
		return lines.length ? lines[lines.length - 1] : "starting";
	} catch {
		return "no log";
	}
}

/** Stop the projection if one is live. Safe to call when none is. */
async function xvfbMirrorStop(): Promise<void> {
	if (!xvfbMirrorProc) return;
	const pid = xvfbMirrorProc.pid;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		/* already gone */
	}
	const deadline = Date.now() + 3000;
	for (;;) {
		let alive = false;
		try {
			process.kill(pid, 0);
			alive = true;
		} catch {
			break;
		}
		if (!alive || Date.now() >= deadline) break;
		await new Promise(r => setTimeout(r, 100));
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
	xvfbMirrorProc = null;
}

/**
 * Detect an on-screen credential prompt from OCR text — the signal that a step
 * needs the USER (a password, sudo, an SSH passphrase, a PIN/2FA, a key
 * passphrase). Deliberately conservative: only strong, unambiguous phrasings
 * count, and we never read what is typed into the prompt.
 */
export function xvfbAuthPromptHint(ocrText: string | undefined): string | null {
	if (!ocrText) return null;
	const t = ocrText.toLowerCase();
	const patterns: Array<[RegExp, string]> = [
		// Most specific first: the generic "password:" is last so it cannot
		// shadow a better label.
		[/\[sudo\] password|(^|\n)\s*sudo\b[^\n]*password/, "sudo password"],
		[/\S+@\S+'s password|password for \S+@\S+/, "ssh password"],
		[/\bpassphrase\b/, "passphrase"],
		[/enter\s+(your\s+)?(password|passphrase)/, "password entry"],
		[/authentication (is )?required/, "authentication required"],
		[/\bpin\b\s*[:=]|enter\s+(your\s+)?pin\b/, "PIN entry"],
		[/two[- ]factor|2fa|verification code|one[- ]time (code|password)/, "2FA / verification code"],
		[/\bunlock\b.*\b(password|key)\b|\bkey\s+passphrase\b/, "unlock secret"],
		// Last resort: any "password:"/"passphrase:"-style label. Allows trailing
		// glyphs (a cursor or shell prompt echo, e.g. "Password: ||").
		[/\bpass(word|phrase)\s*[:=]/, "password prompt"],
	];
	for (const [re, label] of patterns) {
		if (re.test(t)) return label;
	}
	return null;
}

function xvfbCommandFixup(cmd: string): string {
	// Wayland-native apps refuse to fall back to X11 silently — force it.
	if (/\b(brave|chromium|google-chrome|msedge|electron|code)\b/.test(cmd) && !cmd.includes("--ozone-platform")) {
		return cmd.replace(/^(flatpak run \S+|[^ ]+\.AppImage|\S+)/, "$& --ozone-platform=x11");
	}
	return cmd;
}
/** One mapped window on the virtual display: id + absolute position + size. */
export interface XvfbMappedWindow {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Enumerate visible windows with absolute geometry. Exported for tests. */
export async function xvfbMappedWindows(): Promise<XvfbMappedWindow[]> {
	const res = await runCmd("xdotool", ["search", "--onlyvisible", "--name", "."], { env: xvfbEnv() });
	if (res.code !== 0) return [];
	const ids = res.stdout
		.split("\n")
		.map(s => s.trim())
		.filter(s => /^\d+$/.test(s));
	const out: XvfbMappedWindow[] = [];
	for (const id of ids) {
		const g = await runCmd("xdotool", ["getwindowgeometry", "--shell", id], { env: xvfbEnv() });
		if (g.code !== 0) continue;
		const num = (re: RegExp): number | null => {
			const m = re.exec(g.stdout);
			return m ? Number(m[1]) : null;
		};
		const x = num(/X=(-?\d+)/);
		const y = num(/Y=(-?\d+)/);
		const w = num(/WIDTH=(\d+)/);
		const h = num(/HEIGHT=(\d+)/);
		if (x === null || y === null || w === null || h === null) continue;
		out.push({ id, x, y, w, h });
	}
	return out;
}

/** Composite every visible window onto a white canvas at absolute positions
 *  so ARGB/GL apps — which bare Xvfb never paints into the root framebuffer
 *  — become readable. Coordinates stay fullscreen-origin, so existing click
 *  mapping is untouched. The canvas is white (not the black root): tesseract's
 *  default page segmentation misses a small text island on a giant black
 *  canvas, and the black root carries no usable pixels anyway. The root seed
 *  is applied only when the root is NOT effectively blank, so a black sheet
 *  never recreates the trap we are escaping. Returns the stacked path, or
 *  null when no window contributed pixels. Best-effort: never throws. */
export async function xvfbCompositeWindows(rootPath: string, windows: XvfbMappedWindow[]): Promise<string | null> {
	try {
		const [physW, physH] = xvfbGeometry();
		const stackPath = path.join(os.tmpdir(), `aerys-xvfb-stack-${Date.now()}.png`);
		const base = await runCmd("convert", ["-size", `${physW}x${physH}`, "xc:white", stackPath], {
			env: xvfbEnv(),
			timeout: 15_000,
		});
		if (base.code !== 0 || !fs.existsSync(stackPath)) return null;
		// Seed the canvas with any root pixels that exist (non-ARGB apps such
		// as the widget/mousepad paint straight into the framebuffer).
		const mean = await runCmd("identify", ["-format", "%[fx:mean]", rootPath], { timeout: 10_000 });
		const rootBrightness = Number(mean.stdout);
		if (Number.isFinite(rootBrightness) && rootBrightness > 0.01) {
			await runCmd("convert", [stackPath, rootPath, "-flatten", stackPath], { env: xvfbEnv(), timeout: 15_000 });
		}
		let layers = 0;
		for (const w of windows) {
			if (w.w <= 0 || w.h <= 0) continue;
			const winPath = path.join(os.tmpdir(), `aerys-xvfb-win-${Date.now()}-${w.id}.png`);
			const shot = await runCmd("import", ["-window", w.id, winPath], { env: xvfbEnv(), timeout: 15_000 });
			if (shot.code !== 0 || !fs.existsSync(winPath)) continue;
			const wmean = await runCmd("identify", ["-format", "%[fx:mean]", winPath], { timeout: 10_000 });
			const brightness = Number(wmean.stdout);
			if (!Number.isFinite(brightness) || brightness <= 0.001) continue;
			const flatWin = path.join(os.tmpdir(), `aerys-xvfb-winflat-${Date.now()}-${w.id}.png`);
			const flatRes = await runCmd("convert", [winPath, "-background", "white", "-alpha", "remove", "-alpha", "off", flatWin], {
				env: xvfbEnv(),
				timeout: 15_000,
			});
			if (flatRes.code !== 0 || !fs.existsSync(flatWin)) continue;
			// Clamp the paste origin so offscreen windows cannot corrupt the stack.
			const px = Math.max(0, Math.min(w.x, physW - 1));
			const py = Math.max(0, Math.min(w.y, physH - 1));
			const comp = await runCmd(
				"convert",
				[stackPath, flatWin, "-geometry", `+${px}+${py}`, "-composite", stackPath],
				{ env: xvfbEnv(), timeout: 15_000 },
			);
			if (comp.code === 0) layers++;
		}
		return layers > 0 ? stackPath : null;
	} catch {
		return null;
	}
}

async function xvfbListWindows(): Promise<string[]> {
	const res = await runCmd("xdotool", ["search", "--onlyvisible", "--name", ".", "getwindowname", "%@"], {
		env: xvfbEnv(),
	});
	return res.code === 0
		? res.stdout
				.split("\n")
				.map(s => s.trim())
				.filter(Boolean)
		: [];
}

/** Names present in `after` but not in `before`, matched case-insensitively.
 *  Used by xvfb_launch to name exactly which windows THAT launch produced —
 *  polling alone is not enough, because a pre-existing window makes "any
 *  window mapped" true instantly and the new app is never confirmed.
 *  Exported for tests. */
export function xvfbNewWindows(before: string[], after: string[]): string[] {
	const seen = new Set(before.map(w => w.trim().toLowerCase()));
	return after.filter(w => !seen.has(w.trim().toLowerCase()));
}

/** Poll for a mapped window on the virtual display (bounded). Replaces the
 *  old fixed 4s sleep: return the moment a window maps, or the timeout list
 *  so the caller can still report what is actually present. */
async function xvfbPollForWindows(timeoutMs = 8000, intervalMs = 200): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const windows = await xvfbListWindows();
		if (windows.length > 0 || Date.now() >= deadline) return windows;
		await new Promise(r => setTimeout(r, intervalMs));
	}
}

/** Focused window id on the virtual display (for activate-before-input).
 *  Best-effort: null when nothing is focused or xdotool errors. */
async function xvfbFocusedWindowId(): Promise<string | null> {
	const res = await runCmd("xdotool", ["getactivewindow"], { env: xvfbEnv() });
	return res.code === 0 && res.stdout ? res.stdout.trim() : null;
}

/** Where keyboard input should land on the virtual display. With a window
 *  manager the active window is authoritative. Bare Xvfb has no WM at all:
 *  nothing ever holds input focus (X focus stays on the root window), so
 *  activate-before-type silently drops every keystroke into focusless
 *  space — yad echoed nothing typed, xarchiver's Ctrl+N did nothing. There
 *  we set input focus explicitly: prefer the window under the pointer
 *  (click-to-focus semantics), else the first visible named window, via
 *  windowfocus (XSetInputFocus — needs no WM). Exported for tests. */
export async function xvfbKeyboardTarget(): Promise<{ id: string; viaActiveWindow: boolean } | null> {
	const active = await xvfbFocusedWindowId();
	if (active) return { id: active, viaActiveWindow: true };
	const mouse = await runCmd("xdotool", ["getmouselocation", "--shell"], { env: xvfbEnv() });
	if (mouse.code === 0) {
		const underPointer = mouse.stdout.split("\n").find(l => l.startsWith("WINDOW="))?.slice(7).trim();
		// The bare root window has no name; a nameless window is not app input.
		if (underPointer && underPointer !== "0") {
			const name = await runCmd("xdotool", ["getwindowname", underPointer], { env: xvfbEnv() });
			if (name.code === 0 && name.stdout.trim()) return { id: underPointer, viaActiveWindow: false };
		}
	}
	const list = await runCmd("xdotool", ["search", "--onlyvisible", "--name", "."], { env: xvfbEnv() });
	if (list.code !== 0 || !list.stdout.trim()) return null;
	for (const id of list.stdout.trim().split("\n")) {
		const named = await runCmd("xdotool", ["getwindowname", id.trim()], { env: xvfbEnv() });
		if (named.code === 0 && named.stdout.trim()) return { id: id.trim(), viaActiveWindow: false };
	}
	return null;
}

/** Current pointer position on the virtual display (X,Y) — null when unknown.
 *  Used as the origin of a smooth approach; a missing read means we fall back
 *  to an uncurved path from the target itself (never a blind jump). */
export async function xvfbPointerPosition(): Promise<{ x: number; y: number } | null> {
	const res = await runCmd("xdotool", ["getmouselocation", "--shell"], { env: xvfbEnv() });
	if (res.code !== 0) return null;
	const x = Number(res.stdout.match(/^X=(-?\d+)/m)?.[1]);
	const y = Number(res.stdout.match(/^Y=(-?\d+)/m)?.[1]);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y };
}

/**
 * Play a motion path through a SINGLE `xdotool -` process: one mousemove per
 * step with an inline `sleep` carrying that step's wait, then a button
 * choreography. Streaming beats per-step spawns by ~17x (measured 0.43 vs
 * 7.13 ms/step) and `sleep` paces the steps for real, which is what makes the
 * sweep read as motion instead of a teleport.
 *
 * Two choreographies, one vocabulary:
 * - click (press===release): approach steps, settle, press, hold, release,
 *   trailing settle. The pointer is already settled when the button goes down.
 * - drag (approach + sweep): approach steps to the press point, settle, press
 *   with its own hold, the held sweep, an end dwell, release, trailing settle.
 */
export function xvfbPathScript(
	steps: MotionStep[],
	options: { press?: string; release?: string; settleMs?: number; holdMs?: number } = {},
): string {
	const lines: string[] = [];
	for (const s of steps) {
		lines.push(`mousemove --sync ${Math.round(s.x)} ${Math.round(s.y)}`);
		const sleepMs = Math.max(1, Math.round(s.waitMs)) / 1000;
		if (sleepMs > 0) lines.push(`sleep ${sleepMs.toFixed(3)}`);
	}
	if (options.settleMs && options.settleMs > 0) {
		lines.push(`sleep ${(options.settleMs / 1000).toFixed(3)}`);
	}
	if (options.press) {
		lines.push(`mousedown ${options.press}`);
		if (options.holdMs && options.holdMs > 0) lines.push(`sleep ${(options.holdMs / 1000).toFixed(3)}`);
	}
	if (options.release) lines.push(`mouseup ${options.release}`);
	if (options.release && options.settleMs && options.settleMs > 0) {
		lines.push(`sleep ${(options.settleMs / 1000).toFixed(3)}`);
	}
	return `${lines.join("\n")}\n`;
}

export async function xvfbInjectPath(
	steps: MotionStep[],
	options: { press?: string; release?: string; settleMs?: number; holdMs?: number } = {},
): Promise<{ code: number; stderr: string }> {
	const script = xvfbPathScript(steps, options);
	// runCmd cannot feed stdin, so the batch is handed to `xdotool -` through a
	// printf pipe. This is the single injection point for every paced path.
	const piped = await runCmd("sh", ["-c", `printf '%s' "$MOTION" | DISPLAY=${XVFB_DISPLAY} xdotool -`], {
		env: { ...xvfbEnv(), MOTION: script },
		timeout: 30_000,
	});
	return { code: piped.code, stderr: piped.stderr };
}

/**
 * Build the full held-drag batch script: paced approach to the press point,
 * press+hold, the held sweep itself as paced steps (no release yet), the end
 * dwell, release, trailing settle. The sweep keeps the button down for the
 * whole travel — that is what makes the app select instead of hover.
 */
export function xvfbDragScript(
	approach: MotionStep[],
	sweep: MotionStep[],
	options: { button: string; settleMs: number; pressHoldMs: number; endHoldMs: number; afterMs: number },
): string {
	// Approach ends with mousedown + the press hold (no release yet), so the
	// sweep below starts with the button already down and held visibly.
	const head = xvfbPathScript(approach, {
		press: options.button,
		settleMs: options.settleMs,
		holdMs: options.pressHoldMs,
	}).trimEnd();
	const lines: string[] = head ? [head] : [];
	for (const s of sweep) {
		lines.push(`mousemove --sync ${Math.round(s.x)} ${Math.round(s.y)}`);
		lines.push(`sleep ${(Math.max(1, Math.round(s.waitMs)) / 1000).toFixed(3)}`);
	}
	lines.push(`sleep ${(options.endHoldMs / 1000).toFixed(3)}`);
	lines.push(`mouseup ${options.button}`);
	lines.push(`sleep ${(options.afterMs / 1000).toFixed(3)}`);
	return `${lines.join("\n")}\n`;
}

export async function xvfbInjectDrag(
	approach: MotionStep[],
	sweep: MotionStep[],
	options: { button: string; settleMs: number; pressHoldMs: number; endHoldMs: number; afterMs: number },
): Promise<{ code: number; stderr: string }> {
	const script = xvfbDragScript(approach, sweep, options);
	const piped = await runCmd("sh", ["-c", `printf '%s' "$MOTION" | DISPLAY=${XVFB_DISPLAY} xdotool -`], {
		env: { ...xvfbEnv(), MOTION: script },
		timeout: 30_000,
	});
	return { code: piped.code, stderr: piped.stderr };
}
/** ---------- Headless eye (xvfb) ----------
 * The virtual display's eye: one capture → one downscale → OCR → clickTargets.
 * Mirrors live_eye's contract (text + word targets in scaled-frame px) but
 * lives entirely inside Xvfb — it never touches the real Wayland desktop.
 * Frame is the fullscreen virtual display anchored at the origin; xvfb_click
 * maps scaled-frame px back to raw display px through it. Kept separate from
 * the live stack's lastInputFrame/lastClickTargets so the two worlds can
 * never cross-contaminate each other's coordinates. */
interface XvfbFrameState {
	physW: number;
	physH: number;
	scaledW: number;
	scaledH: number;
}
let xvfbFrame: XvfbFrameState | null = null;
let xvfbClickTargets: ClickTarget[] = [];
/** Bumped by every xvfb_screenshot and xvfb_close; word targets carry the
 *  generation of the reading that produced them, so boxes from an older
 *  reading can never be mapped through a newer frame. `-1` = no valid
 *  targets (ocr:false pass, empty capture, or closed session). */
let xvfbGeneration = 0;
let xvfbTargetsGeneration = -1;

/** Most frequent color in ImageMagick `histogram:info:-` output — the
 *  background of a trimmed text region (glyph pixels never outnumber
 *  background pixels). Parses the decimal histogram tuple `(r,g,b)` and
 *  re-emits it as a `srgb(r,g,b)` color spec; `null` = nothing parseable
 *  (caller falls back to white). Exported for tests. */
export function dominantColor(histOutput: string): string | null {
	let best: { count: number; color: string } | null = null;
	for (const line of histOutput.split("\n")) {
		const m = line.match(/^\s*(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/);
		if (!m) continue;
		const count = Number(m[1]);
		const color = `srgb(${Number(m[2])},${Number(m[3])},${Number(m[4])})`;
		if (!best || count > best.count) best = { count, color };
	}
	return best ? best.color : null;
}
/** Content-bounds view of a capture (fuzz-trimmed to the painted region,
 *  then padded with the capture's own background color). Tesseract's page
 *  segmentation (--psm 6) reliably MISSES a small text island sitting on a
 *  huge blank canvas — a 520x200 dialog on a 1600x900 desktop loses its
 *  button row entirely, while the identical pixels read fine once trimmed.
 *  Trimming recovers that text and returns where the crop came from, so
 *  word boxes can still be folded back into full-frame coordinates.
 *  The padding is essential: tesseract also drops text flush against the
 *  image edge — and it must match the capture's background, because a
 *  white border around a dark-theme crop (bright glyphs on black) erases
 *  the text flush against it and the rescue reads nothing at all.
 *  Returns null when the trim would not shrink the canvas (dense captures
 *  like a full-window app are already well-framed, and trimming them would
 *  only add cost). */
export async function xvfbContentCrop(
	imgPath: string,
	opts: { fuzzPct?: number; pad?: number; minAreaGain?: number } = {},
): Promise<{ croppedPath: string; x: number; y: number; w: number; h: number; pad: number } | null> {
	const fuzz = opts.fuzzPct ?? 10;
	const pad = opts.pad ?? 25;
	const minAreaGain = opts.minAreaGain ?? 1.35;
	const dims = await identifyDims(imgPath);
	if (!dims) return null;
	const [fullW, fullH] = dims;
	const geo = await runCmd("convert", [imgPath, "-fuzz", `${fuzz}%`, "-trim", "-format", "%w %h %X %Y", "info:"]);
	if (geo.code !== 0) return null;
	// ImageMagick reports the offset as "+X+Y" with a leading sign.
	const parts = geo.stdout
		.trim()
		.replace(/[+-]/g, " ")
		.split(/\s+/)
		.map(Number);
	if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
	const [cw, ch, cx, cy] = parts as [number, number, number, number];
	// Degenerate trims say "nothing to rescue": a blank canvas trims to
	// nothing and a solid canvas trims to a lone stray pixel. A 1x1 crop
	// has no text to read (and used to fall through to the byte-size gate,
	// which only rejected it by accident of its ~300-byte PNG).
	if (cw < 4 || ch < 4) return null;
	// Only worth it when the content occupies a small slice of the canvas.
	if (cw * ch * minAreaGain >= fullW * fullH) return null;
	const croppedPath = path.join(os.tmpdir(), `aerys-xvfb-content-${Date.now()}.png`);
	// Pad with the capture's own background, not white: the crop bounds the
	// painted region, and for a dark-theme app (bright glyphs on black) a
	// white border erases the glyphs flush against it — tesseract then reads
	// nothing at all, defeating the rescue. The crop's DOMINANT color is that
	// background (glyph pixels never outnumber background pixels), which
	// keeps the glyph/background contract the crop had; fall back to white
	// for unparseable output (the pre-dark-theme behavior).
	const hist = await runCmd("convert", [
		imgPath,
		"-crop",
		`${cw}x${ch}+${Math.max(0, cx)}+${Math.max(0, cy)}`,
		"+repage",
		"-format",
		"%c",
		"histogram:info:-",
	]);
	const bgColor = dominantColor(hist.stdout) ?? "white";
	const crop = await runCmd("convert", [
		imgPath,
		"-crop",
		`${cw}x${ch}+${Math.max(0, cx)}+${Math.max(0, cy)}`,
		"+repage",
		"-bordercolor",
		bgColor,
		"-border",
		String(pad),
		croppedPath,
	]);
	// Validity is dimensional, not byte-size: a solid-color crop (e.g. a
	// black rectangle trimmed from a light capture, padded to match) PNGs to
	// ~300 bytes, which the old `size <= 500` gate misread as failure.
	const cropDims = await identifyDims(croppedPath);
	if (crop.code !== 0 || !fs.existsSync(croppedPath) || !cropDims) return null;
	const [gotW, gotH] = cropDims;
	if (Math.abs(gotW - (cw + 2 * pad)) > 2 || Math.abs(gotH - (ch + 2 * pad)) > 2) return null;
	return { croppedPath, x: Math.max(0, cx), y: Math.max(0, cy), w: cw, h: ch, pad };
}

/** Read one xvfb root capture: downscale once, OCR the scaled image, build
 *  click targets. `emptyRoot` = nothing usable was seen (tiny capture, or no
 *  text and no targets) — callers surface that instead of a silent success.
 *  When the scaled read comes back sparse (the small-island-on-blank-canvas
 *  segmentation trap), the same capture is re-read through a fuzz-trimmed
 *  content crop and the richer reading wins — word boxes are folded back into
 *  full-frame coordinates through the crop offset, so the coordinate contract
 *  never changes. */
/** Coverage gate for the segmentation rescue. The trap is words clustered
 *  in a small region of a big canvas (psm 6 then drops whole rows), which
 *  the primary pass's own word boxes already tell us: their union bbox is
 *  free to compute. True when that union covers less than a quarter of the
 *  frame, or when nothing was read at all. Exported for tests. */
export function xvfbRescueWanted(
	words: Array<{ x: number; y: number; w: number; h: number }>,
	canvasW: number,
	canvasH: number,
): boolean {
	if (words.length === 0) return true;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const w of words) {
		x0 = Math.min(x0, w.x);
		y0 = Math.min(y0, w.y);
		x1 = Math.max(x1, w.x + w.w);
		y1 = Math.max(y1, w.y + w.h);
	}
	const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
	return area / (canvasW * canvasH) < 0.25;
}

export async function headlessEyeRead(opts: {
	rawPath: string;
	physW: number;
	physH: number;
	maxWidth?: number;
	maxHeight?: number;
	ocr?: boolean;
}): Promise<{
	text: string;
	words: number;
	targets: ClickTarget[];
	frame: InputFrame;
	emptyRoot: boolean;
	ocrError?: string;
	ocrMode?: "native" | "upscaled";
	ocrMs: number;
	scaledPath: string;
}> {
	const t0 = Date.now();
	const scaledPath = path.join(os.tmpdir(), `aerys-xvfb-eye-${Date.now()}-scaled.png`);
	const maxW = opts.maxWidth ?? 1280;
	const maxH = opts.maxHeight ?? 800;
	// ONE downscale pass: OCR and clickTargets both read the scaled image, so
	// every coordinate the model sees (and clicks with) is scaled-frame px.
	const conv = await runCmd("convert", [opts.rawPath, "-resize", `${maxW}x${maxH}>`, scaledPath]);
	const tiny = conv.code !== 0 || !fs.existsSync(scaledPath) || fs.statSync(scaledPath).size <= 500;
	const wantOcr = opts.ocr ?? true;
	let ocr = tiny || !wantOcr ? null : await ocrFrame(scaledPath);
	const dims = tiny ? null : await identifyDims(scaledPath);
	const frame: InputFrame = {
		kind: "fullscreen",
		atX: 0,
		atY: 0,
		physW: opts.physW,
		physH: opts.physH,
		scaledW: dims?.[0] ?? opts.physW,
		scaledH: dims?.[1] ?? opts.physH,
	};
	// Segmentation rescue: a small text region on a big canvas makes
	// tesseract's block layout (--psm 6) silently drop whole rows — a 520x200
	// dialog on a 1600x900 desktop loses its buttons entirely, while the same
	// pixels read fine once trimmed. Re-read through a fuzz-trimmed,
	// white-padded content crop and MERGE what it saw with the primary pass:
	// the crop offset folds every new box back into scaled-frame pixels, so
	// the coordinate contract is unchanged, and merging means a box the
	// primary pass already had can never regress.
	// The trigger is coverage, not character count: after typing into the
	// dialog a read can carry well over 20 chars and STILL lose its button
	// row (yad did exactly that). The trap is words clustered in a small
	// region of the canvas, which the primary pass's own word boxes already
	// tell us — xvfbRescueWanted computes their union bbox for free, so
	// dense captures skip the probe entirely and the fuzz-trim's own
	// conservative gate stays as the second guard.
	if (wantOcr && !tiny && ocr && xvfbRescueWanted(ocr.words ?? [], frame.scaledW, frame.scaledH)) {
		const crop = await xvfbContentCrop(scaledPath);
		if (crop) {
			const alt = await ocrFrame(crop.croppedPath);
			const folded = (alt.words ?? []).map(w => ({
				...w,
				x: Math.max(0, w.x + crop.x - crop.pad),
				y: Math.max(0, w.y + crop.y - crop.pad),
			}));
			// Merge: keep the primary boxes, add crop boxes that aren't already
			// covered (same text, near-identical box).
			const merged = [...(ocr.words ?? [])];
			for (const w of folded) {
				const dup = merged.some(
					m => m.text === w.text && Math.abs(m.x - w.x) <= 6 && Math.abs(m.y - w.y) <= 6,
				);
				if (!dup) merged.push(w);
			}
			const primary = (ocr.text ?? "").replace(/\s+/g, "").length;
			const rescued = (alt.text ?? "").replace(/\s+/g, "").length;
			const text = rescued > primary ? alt.text : ocr.text;
			if (merged.length !== (ocr.words ?? []).length || rescued > primary) {
				ocr = { ...ocr, text, words: merged };
			}
		}
	}
	const words = (ocr?.words ?? []).map(w => ({ ...w, confidence: normalizeOcrConfidence(w.confidence) }));
	// A blank frame must yield no targets: clickTargetsFromOcr keys off words,
	// and an empty reading is surfaced via emptyRoot rather than faked.
	const targets = wantOcr ? clickTargetsFromOcr(words, frame) : [];
	const text = ocr?.text ?? "";
	return {
		text,
		words: words.length,
		targets,
		frame,
		emptyRoot: tiny || (text === "" && targets.length === 0),
		...(ocr?.error ? { ocrError: ocr.error } : {}),
		...(ocr?.mode ? { ocrMode: ocr.mode } : {}),
		ocrMs: Date.now() - t0,
		scaledPath,
	};
}

/** Remember the xvfb eye's word targets for target-based xvfb_click.
 *  Separate store from the live stack's lastClickTargets — headless and real
 *  desktop coordinates must never mix.
 *  The generation stamp is what keeps this honest: word targets are expressed
 *  in the frame of ONE reading, so a later xvfb_screenshot with a different
 *  frame (a maxWidth/maxHeight cap, a window-composite rescue, an ocr:false
 *  pass that skips OCR entirely) must invalidate them. Without this, a stale
 *  box mapped through a NEW frame silently clicks somewhere else — e.g.
 *  B2 mapped through a 640-wide frame landed at display 188,218 instead of
 *  375,435. Fail closed instead: no matching generation ⇒ no word click.
 *  Exported for tests. */
export function rememberXvfbTargets(targets: ClickTarget[]): void {
	xvfbClickTargets = targets;
	xvfbTargetsGeneration = targets.length > 0 ? xvfbGeneration : -1;
}

/** True when word targets exist AND belong to the frame currently in force.
 *  A reading that produced no targets (ocr:false, or a blank capture) leaves
 *  no valid targets behind, so target-based clicks refuse rather than reuse
 *  an older reading's boxes. Exported for tests. */
export function xvfbTargetsAreCurrent(): boolean {
	return xvfbClickTargets.length > 0 && xvfbTargetsGeneration === xvfbGeneration;
}

/** Resolve a word target against the LAST xvfb eye reading. Same precedence
 *  as resolveClickTarget, but garbage OCR boxes are distrusted: merged
 *  column fragments (a box far taller than a real label, e.g. "ARR]"
 *  spanning a whole grid column) are skipped unless NOTHING else matches,
 *  and a crisp high-confidence word beats a mangled fragment that merely
 *  contains the query ("B2" the label vs "(B2" the smear). Frame binding is
 *  enforced by the caller (xvfbTargetsAreCurrent failing closed in
 *  xvfb_click); resolve itself refuses when no valid generation exists, so
 *  a stale box can never be handed out silently. Returns the scaled-frame
 *  center. */
export function resolveXvfbTarget(text: string): { x: number; y: number; box: ClickTarget } | null {
	const q = text.trim().toLowerCase();
	if (!q || !xvfbTargetsAreCurrent()) return null;
	const sane = (t: ClickTarget): boolean => t.h <= Math.max(32, t.w * 2.2);
	const rank = (a: ClickTarget, b: ClickTarget): number => {
		const ea = a.text.toLowerCase() === q ? 0 : 1;
		const eb = b.text.toLowerCase() === q ? 0 : 1;
		if (ea !== eb) return ea - eb;
		// Prefer high-confidence boxes: a crisp exact word beats a taller
		// merged fragment that merely contains the query ("B2" the label vs
		// "(B2" the column smear).
		const ca = a.confidence ?? 0;
		const cb = b.confidence ?? 0;
		if (Math.abs(ca - cb) > 0.3) return cb - ca;
		if (a.text.length !== b.text.length) return a.text.length - b.text.length;
		return a.y - b.y || a.x - b.x;
	};
	const matches = xvfbClickTargets.filter(t => t.text.toLowerCase().includes(q));
	if (matches.length === 0) return null;
	const good = matches.filter(sane).sort(rank);
	const best = (good.length > 0 ? good : matches.sort(rank))[0];
	return { x: best.x + Math.round(best.w / 2), y: best.y + Math.round(best.h / 2), box: best };
}

/** Map scaled-frame px (what the model sees on the xvfb screenshot) to raw
 *  display px (what xdotool injects). No frame ⇒ coords are already display
 *  px (passthrough). Exported for tests. */
export function xvfbFrameToDisplay(
	x: number,
	y: number,
	frame: { physW: number; physH: number; scaledW: number; scaledH: number } | null,
): [number, number] {
	if (!frame) return [x, y];
	return [Math.round((x * frame.physW) / frame.scaledW), Math.round((y * frame.physH) / frame.scaledH)];
}

/** xdotool argv for xvfb_type: focus (and wait for) the target window
 *  first so keystrokes land in it, then type. windowfocus works without a
 *  window manager; --sync gates on the X focus actually moving. Exported
 *  for tests. */
export function buildXvfbTypeArgs(text: string, windowId?: string): string[] {
	return windowId
		? ["windowfocus", "--sync", windowId, "type", "--delay", "40", text]
		: ["type", "--delay", "40", text];
}

/** xdotool argv for xvfb_key: same focus-first discipline. Exported for
 *  tests. */
export function buildXvfbKeyArgs(keys: string, windowId?: string): string[] {
	return windowId ? ["windowfocus", "--sync", windowId, "key", keys] : ["key", keys];
}


/** Window listing via the platform driver (Hyprland native, X11, …). */
async function getDriverWindows(): Promise<DesktopWindowInfo[]> {
	return detectPlatformDriver().windows.listWindows();
}

/** Active focused window via the platform driver. */
async function getDriverActiveWindow(): Promise<DesktopWindowInfo | undefined> {
	return detectPlatformDriver().windows.activeWindow();
}

/**
 * Focus fast path: dispatch focus by window address and confirm with a short
 * poll (default 5 × 120ms). Returns the focused window or an error string.
 * Exported for tests and the browser-drive harness.
 */
export async function focusWindowFast(
	address: string,
	polls = 5,
	pollMs = 120,
): Promise<DesktopWindowInfo | { error: string }> {
	const driver = detectPlatformDriver();
	if (!isSupportedDriver()) return { error: `live input is not supported on this platform yet (${driver.label}).` };
	const err = await driver.windows.focusWindow(address);
	if (err) return { error: err };
	for (let i = 0; i < polls; i++) {
		await new Promise(r => setTimeout(r, pollMs));
		const win = await driver.windows.activeWindow().catch(() => undefined);
		if (win?.address === address) return win;
	}
	return { error: `window ${address} did not become active after ${polls} polls — focus it yourself and retry.` };
}

/* ================= Live desktop app-control (D002/D004) =================
 * Model-visible coordinate frame = the last screenshot this tool returned (a window
 * or the full display, downscaled to ≤ maxWidth×maxHeight). live_* actions inject
 * input into the FOCUSED window; their coordinates are frame px mapped back to
 * compositor pixels at execution time (TARS/CUDemo coordinate discipline).
 * Safety gate: opt-in app-control mode + first-use prompt per action kind (D004),
 * enforced via the host approval resolver below.
 */
let liveModeEnabled = false;
/** Continuous observation: one session-scoped snapshot anchored to the exact
 *  window address of the latest eye/verify reading. live_* actions consult it
 *  for fresh coordinates; it never injects input itself. */
const liveObservation = new ObservationController();
let lastInputFrame: InputFrame | null = null;

const LIVE_GATE_ACTIONS = new Set<string>([
	"live_mode_on",
	"live_mode_off",
	"live_mode_status",
	"live_backend_probe",
	"live_eye", // read-tier glance: capture-only, marks itself ephemeral
]);
const liveAuthorizedKinds = new Set<string>();

/** --- Drive loop: per-action safety counters (clippy ScreenAgent pattern) - */

/**
 * Failure/abandonment guardrails for a model-driven loop: track consecutive
 * failures, same-step repeats, and same-direction scrolls across live_*
 * injection calls so a stuck model aborts instead of looping forever.
 * Exported for tests; a re-look (live_eye / screenshot) resets the counters —
 * that is the recovery path the abort messages point at.
 */
export interface DriveLoopState {
	consecutiveFailures: number;
	lastAction: string;
	repeatCount: number;
	/** Outcome of the last non-scroll action — the repeat streak only grows
	 *  when the same action yields the SAME outcome (a changed outcome means
	 *  something changed, so the streak restarts). */
	lastOutcome: "success" | "failure" | "";
	lastScrollDir: string;
	scrollCount: number;
}

/** clippy parity: abort after 3 consecutive failures. The repeat streak only
 *  counts repeats of the SAME STEP — the action plus the argument that
 *  distinguishes it (target word, typed text, pointer coords). Three clicks on
 *  three different links are three different steps and never trip it; three
 *  clicks on the same dead label do. Same-direction scrolls may run longer
 *  (5) because scrolling-to-find is a legitimate pattern. */
export const DRIVE_LOOP_MAX_FAILURES = 3;
export const DRIVE_LOOP_MAX_SCROLLS = 5;
export const DRIVE_LOOP_MAX_REPEATS = 3;
const driveLoop: DriveLoopState = {
	consecutiveFailures: 0,
	lastAction: "",
	repeatCount: 0,
	lastOutcome: "",
	lastScrollDir: "",
	scrollCount: 0,
};
/** Fingerprint of the last counted step. Internal (not in the public
 *  snapshot) — the streak must compare steps, not bare action names, or a
 *  legitimate multi-step flow ("click a link, verify, click another") reads
 *  as a stuck loop and wedges the session. */
let lastStep: string | undefined;
/** Fingerprint of one injection step — the action plus the argument that
 *  distinguishes it. Two clicks on different words are different steps;
 *  two clicks on the same word are the same step. Scroll direction and
 *  repeat count are folded in so a double-click isn't a repeat of a click. */
export function driveLoopStepKey(
	action: string,
	p: { target?: string; keys?: string; x?: number; y?: number; x2?: number; y2?: number; direction?: string; button?: string; count?: number },
): string {
	const bits = [action];
	if (p.target) bits.push(`t:${p.target}`);
	if (p.x !== undefined) bits.push(`x:${p.x}`);
	if (p.y !== undefined) bits.push(`y:${p.y}`);
	if (p.x2 !== undefined) bits.push(`x2:${p.x2}`);
	if (p.y2 !== undefined) bits.push(`y2:${p.y2}`);
	if (p.keys !== undefined) bits.push(`k:${p.keys}`);
	if (p.direction) bits.push(`d:${p.direction}`);
	if (p.button) bits.push(`b:${p.button}`);
	if (p.count !== undefined) bits.push(`n:${p.count}`);
	return bits.join("|");
}

/** Observe one injection outcome. `succeeded` = action ran without error;
 *  `scrollDir` = scroll direction for live_scroll ("up"/"down"/"left"/"right");
 *  `step` = driveLoopStepKey fingerprint — omitting it degrades the repeat
 *  streak to bare-action matching (what tests use). */
export function driveLoopObserve(action: string, succeeded: boolean, scrollDir?: string, step?: string): void {
	const outcome = succeeded ? "success" : "failure";
	if (succeeded) {
		driveLoop.consecutiveFailures = 0;
	} else {
		driveLoop.consecutiveFailures++;
	}
	if (action === driveLoop.lastAction && outcome === driveLoop.lastOutcome && step === lastStep) {
		driveLoop.repeatCount++;
	} else {
		driveLoop.lastAction = action;
		driveLoop.lastOutcome = outcome;
		driveLoop.repeatCount = 1;
	}
	lastStep = step ?? action;
	if (action === "live_scroll" && scrollDir) {
		if (scrollDir === driveLoop.lastScrollDir) {
			driveLoop.scrollCount++;
		} else {
			driveLoop.lastScrollDir = scrollDir;
			driveLoop.scrollCount = 1;
		}
	} else if (action !== "live_scroll") {
		driveLoop.lastScrollDir = "";
		driveLoop.scrollCount = 0;
	}
}

/** True when the loop must stop before attempting another injection. The
 *  repeat/scroll rules fire only when the INCOMING step repeats the step that
 *  tripped them — a different step ("try another way") is admitted and the
 *  streak restarts on its own. Omitting `step` (tests) compares nothing, so
 *  a tripped streak always aborts. */
export function driveLoopAbortReason(incomingStep?: string): string | null {
	if (driveLoop.consecutiveFailures >= DRIVE_LOOP_MAX_FAILURES) {
		return `aborted: ${driveLoop.consecutiveFailures} consecutive failures (limit ${DRIVE_LOOP_MAX_FAILURES}) — re-eye and re-plan, do not retry the same step`;
	}
	const sameStep = incomingStep === undefined || incomingStep === lastStep;
	if (sameStep && driveLoop.lastAction !== "live_scroll" && driveLoop.repeatCount >= DRIVE_LOOP_MAX_REPEATS && driveLoop.lastAction) {
		return `aborted: "${driveLoop.lastAction}" repeated ${driveLoop.repeatCount}x on the same step (limit ${DRIVE_LOOP_MAX_REPEATS}) — the step isn't working, try another way`;
	}
	if (sameStep && driveLoop.scrollCount >= DRIVE_LOOP_MAX_SCROLLS) {
		return `aborted: scrolled ${driveLoop.lastScrollDir} ${driveLoop.scrollCount}x without finding the target (limit ${DRIVE_LOOP_MAX_SCROLLS}) — reverse or stop`;
	}
	return null;
}

/** Reset between flows (tests, session restart, and the deliberate re-look:
 *  live_eye / screenshot clear the counters so "re-eye and re-plan" — the
 *  recovery the abort messages name — actually un-sticks the loop. */
export function resetDriveLoop(): void {
	driveLoop.consecutiveFailures = 0;
	driveLoop.lastAction = "";
	driveLoop.repeatCount = 0;
	driveLoop.lastOutcome = "";
	driveLoop.lastScrollDir = "";
	driveLoop.scrollCount = 0;
	lastStep = undefined;
}

/** Snapshot for tool-result details. */
export function driveLoopStatus(): DriveLoopState {
	return { ...driveLoop };
}

function liveApprovalDecision(args: unknown): ToolApprovalDecision {
	const action = (args as { action?: string } | undefined)?.action;
	if (!action || !action.startsWith("live_")) return "read";
	if (LIVE_GATE_ACTIONS.has(action)) return "read";
	// First use of an injection kind is exec-tier ⇒ the host asks Peter once per kind
	// (in always-ask/write modes); repeat uses drop to write tier. yolo stays permissive.
	return liveAuthorizedKinds.has(action)
		? "write"
		: {
				tier: "exec",
				reason: `live desktop input "${action}" (first use this session) — approve this action kind once`,
			};
}

async function identifyDims(filePath: string): Promise<[number, number] | null> {
	const res = await runCmd("identify", ["-format", "%w %h", filePath]);
	if (res.code !== 0) return null;
	const m = res.stdout.trim().split(/\s+/).map(Number);
	return m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1]) && m[0] > 0 && m[1] > 0
		? [m[0], m[1]]
		: null;
}

/** Scaled frame file of the most recent capture — the lazy target hydration
 *  reads it (once) when a `target:` click arrives without remembered words. */
let lastFramePath: string | null = null;
/** The last capture explicitly opted out of OCR (ocr:false) — its words are
 *  deliberately unread, so lazy target hydration must not re-OCR it. */
let lastCaptureOcrOptOut = false;


/** Record the coordinate frame of a finished capture (window or fullscreen).
 *  `geometry` is the grim-style "X,Y WxH" crop string; when the capture was a
 *  plain region (no window), the frame anchors at the CROP ORIGIN — otherwise
 *  a region view's frame px would map clicks to the top-left of the screen
 *  instead of where the crop actually sits. Also remembers the scaled file
 *  path so target resolution can OCR it lazily. */
async function rememberFrame(
	win: DesktopWindowInfo | undefined,
	geometry: string | undefined,
	rawPath: string,
	finalPath: string,
): Promise<InputFrame | null> {
	const raw = await identifyDims(rawPath);
	const scaled = await identifyDims(finalPath);
	if (!raw || !scaled) return null;
	let frame: InputFrame;
	if (geometry && win) {
		frame = {
			kind: "window",
			atX: win.at[0],
			atY: win.at[1],
			physW: raw[0],
			physH: raw[1],
			scaledW: scaled[0],
			scaledH: scaled[1],
			address: win.address,
		};
	} else {
		// Region crop (or true fullscreen). Anchor at the crop origin when a
		// geometry was given; only a geometry-less capture is the real
		// fullscreen frame with origin (0,0).
		const origin = geometry ? parseGeometryOrigin(geometry) : { x: 0, y: 0 };
		frame = {
			kind: win ? "window" : "fullscreen",
			atX: origin.x,
			atY: origin.y,
			physW: raw[0],
			physH: raw[1],
			scaledW: scaled[0],
			scaledH: scaled[1],
			...(win ? { address: win.address } : {}),
		};
	}
	lastInputFrame = frame;
	lastFramePath = finalPath;
	return frame;
}

/** Parse the "X,Y WxH" grim geometry string into its origin. */
function parseGeometryOrigin(geometry: string): { x: number; y: number } {
	const m = geometry.match(/^(-?\d+),(-?\d+)/);
	return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

/**
 * Format the cursor-position verify verdict (nuphus mouse_verify pattern).
 * Aimed and read positions must be in the SAME space (hyprland: logical,
 * since cursorpos shares movecursor's space — probed identical 30ms apart;
 * x11: xdotool pixels). Exported for tests.
 */
export function cursorVerifyNote(aimed: { x: number; y: number }, read: { x: number; y: number } | null): string {
	if (!read) return "";
	const dx = Math.abs(read.x - aimed.x);
	const dy = Math.abs(read.y - aimed.y);
	return dx <= 2 && dy <= 2
		? ` Cursor verify OK (Δ${dx},${dy}px ≤2).`
		: ` Cursor verify MISMATCH: aimed (${aimed.x},${aimed.y}), read (${read.x},${read.y}) (Δ${dx},${dy}px) — re-eye and retry before clicking.`;
}
/**
 * Eased aim glide for the live pointer: intermediate waypoints from `from`
 * to `to` (same space, logical px on Hyprland) so the compositor warp reads
 * as motion instead of a teleport. Short hops (≤24px) land in one step —
 * no point easing a nudge. Longer glides ease out over up to 5 intermediates
 * (fast start, gentle landing, like a hand decelerating onto a target); the
 * final waypoint is always exactly `to`. Pure — exported for tests.
 */
export function liveAimGlide(from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy);
	if (dist <= 24) return [{ x: Math.round(to.x), y: Math.round(to.y) }];
	const n = Math.min(5, 2 + Math.floor(dist / 200));
	const pts: Array<{ x: number; y: number }> = [];
	for (let i = 1; i <= n; i++) {
		// easeOutCubic: covers ground fast, then settles onto the target.
		const t = 1 - Math.pow(1 - i / n, 3);
		pts.push({ x: Math.round(from.x + dx * t), y: Math.round(from.y + dy * t) });
	}
	// Rounding can duplicate the final waypoint — collapse it.
	const last = pts[pts.length - 1];
	if (last.x === Math.round(to.x) && last.y === Math.round(to.y)) return pts;
	pts.push({ x: Math.round(to.x), y: Math.round(to.y) });
	return pts;
}

/** Anchor the session observation to the last successful window reading.
 *  Fail-closed by construction: only a frame carrying an exact window
 *  address anchors; fullscreen/region frames (no address) replace the
 *  snapshot with nothing and instead cancel it, so a stale window frame
 *  can never drive input after an unanchored glance. Returns the detail
 *  fragment merged into the tool result (observation generation + age data
 *  flow through the normal result path, no new visible output). */
function anchorLiveObservation(
	readings: Array<{ frame: InputFrame | null; text?: string; windowRect?: ActiveGeometry }>,
	now = Date.now(),
): Record<string, unknown> {
	const last = [...readings].reverse().find(r => r.frame);
	if (!last?.frame) {
		liveObservation.cancel();
		return { observation: { anchored: false, reason: "no_frame" } };
	}
	const address = last.frame.address;
	if (!address) {
		liveObservation.cancel();
		return { observation: { anchored: false, reason: "unaddressed_frame" } };
	}
	// Prefer an explicitly-reported window rect; else derive it from a window
	// frame (its capture rect IS the window rect for a window-targeted eye).
	const windowRect: WindowRect | undefined =
		last.windowRect ??
		(last.frame.kind === "window" ? { at: [last.frame.atX, last.frame.atY], size: [last.frame.physW, last.frame.physH] } : undefined);
	const gen = liveObservation.replace(address, last.frame, now, windowRect);
	if (last.text) liveObservation.noteOcr(gen, last.text, undefined, now);
	return { observation: { anchored: true, generation: gen, address, at: now, windowRect: windowRect ?? null } };
}

/** --- Adaptive observation refresher (phase 3) ------------------------- */

/** Interval between observation refresh ticks while app-control is ON.
 *  Probe-only (one Hyprland focus query, ~17ms, no capture), so the cost is
 *  deliberately modest; overridable via OBS_REFRESH_MS (50..5000). */
const OBS_REFRESH_MS = Math.min(5000, Math.max(50, Number(process.env.OBS_REFRESH_MS ?? 250)));

/** One probe reading: the cheap focus probe's address + geometry. */
export interface ProbeReading {
	address: string;
	at: [number, number];
	size: [number, number];
}

/** PURE decision core of one refresher tick — returns what the tick should
 *  do WITHOUT touching the desktop, so the generation-safety rules are
 *  testable. Rules (all fail-closed):
 *  - snapshot missing/superseded → stop the timer (nothing to keep fresh)
 *  - no usable probe geometry → no-op (never invents data, never refuses;
 *    a probe blip must not kill the refresher)
 *  - same address + same rect → noteWindowRect: re-assert freshness with
 *    live probe data (the human-eye contract: the scene did not move)
 *  - address or rect CHANGED → note-only noop (do NOT overwrite the
 *    anchored rect: the gate must still refuse with address_mismatch /
 *    geometry_mismatch so a mis-aimed click can't ride silent auto-refresh)
 *  - mismatched generation → no-op (a replace() mid-flight re-anchors and
 *    restarts the timer; a superseded snapshot cannot be resurrected).
 *  Re-exported return shape keeps the production callback thin. */
export function observeRefresherTick(
	generation: number,
	probeResult: ProbeReading | null,
	control: ObservationController,
	now = Date.now(),
): { action: "stop" | "noop" | "note"; notedAddress?: string; noteRect?: ActiveGeometry } {
	const snap = control.get();
	if (!snap || snap.superseded) return { action: "stop" };
	if (generation !== snap.generation) return { action: "noop" };
	if (!probeResult || !geometryIsKnown(probeResult)) return { action: "noop" };
	const sameAddress = snap.address === probeResult.address;
	const snapRect = snapshotRect(snap);
	const sameRect =
		!!snapRect && snapRect.at[0] === probeResult.at[0] && snapRect.at[1] === probeResult.at[1]
			&& snapRect.size[0] === probeResult.size[0] && snapRect.size[1] === probeResult.size[1];
	if (sameAddress && sameRect) {
		const noteAddress = control.noteWindowRect(generation, { at: probeResult.at, size: probeResult.size }, now);
		return noteAddress ? { action: "note", notedAddress: snap.address, noteRect: { at: probeResult.at, size: probeResult.size } } : { action: "noop" };
	}
	return { action: "noop" };
}

/** Module refresher state: ONE probe-only timer for the whole session, kept
 *  OUTSIDE the controller so a replace()/re-anchor mid-flow merely restarts
 *  it against the new generation instead of killing continuous freshness. */
let obsRefresherTimer: ReturnType<typeof setInterval> | undefined;
let obsRefresherRunning = false;

/** Start the probe-only refresher (app-control ON). Idempotent. */
function startObservationRefresher(): void {
	if (obsRefresherRunning) return;
	obsRefresherTimer = setInterval(refreshObservationTick, OBS_REFRESH_MS);
	obsRefresherRunning = true;
}

/** Stop the refresher timer (app-control OFF / session teardown). */
function stopObservationRefresher(): void {
	if (obsRefresherTimer !== undefined) clearInterval(obsRefresherTimer);
	obsRefresherTimer = undefined;
	obsRefresherRunning = false;
}

/** One probe-only tick: cheap focus probe → decision → noteWindowRect on
 *  generation match. Never captures, never injects. */
async function refreshObservationTick(): Promise<void> {
	try {
		const win = await getDriverActiveWindow().catch(() => undefined);
		const probeResult: ProbeReading | null = win && win.address ? { address: win.address, at: win.at, size: win.size } : null;
		const decision = observeRefresherTick(liveObservation.get()?.generation ?? -1, probeResult, liveObservation);
		if (decision.action === "stop") stopObservationRefresher();
	} catch {
		// Refresher must never break the session: swallow and try next tick.
	}
}

/** --- Click targets (clickable OCR) ------------------------------------ */

/** A clickable OCR word mapped into model-visible frame px — the same
 *  coordinate contract as live_move/live_click x/y. The model matches
 *  `text` to a UI label and passes x/y (or the whole box) to the pointer. */
export interface ClickTarget {
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
}

/** How many word boxes to surface per reading. A dense window easily
 *  yields hundreds of words; the top-N by area covers buttons/labels/tabs
 *  without flooding the result. */
const MAX_CLICK_TARGETS = 40;

/** Click targets of the most recent OCR'd capture, remembered so
 *  live_move/live_click can take a `target` text ("Compose") instead of
 *  raw coordinates. Module-level like lastInputFrame: one shared desktop. */
let lastClickTargets: ClickTarget[] = [];

/** Convert OCR word boxes into frame-px click targets, clamped into the
 *  frame. Word boxes already arrive in the scaled frame's px space (both
 *  live_eye and screenshot OCR the ≤1280x800 downscaled file, which is the
 *  same coordinate contract live_* understands), so this only filters
 *  junk and clamps edges. Prefers bigger boxes (buttons/labels) over
 *  specks; keeps reading order. Returns [] when there is no frame. */
export function clickTargetsFromOcr(words: OcrWordBox[] | undefined, frame: InputFrame | null): ClickTarget[] {
	if (!words || words.length === 0 || !frame) return [];
	const targets: ClickTarget[] = [];
	for (const b of words) {
		// Junk filter first: symbol-only specks and low-confidence fragments
		// crowd the cap on dense windows and push real labels out.
		if (isJunkTargetWord(b.text, b.confidence)) continue;
		const x = Math.max(0, Math.round(b.x));
		const y = Math.max(0, Math.round(b.y));
		const w = Math.round(b.w);
		const h = Math.round(b.h);
		// Drop boxes fully outside the frame (stale OCR from a resized window).
		if (x >= frame.scaledW || y >= frame.scaledH) continue;
		const clampedW = Math.min(w, frame.scaledW - x);
		const clampedH = Math.min(h, frame.scaledH - y);
		if (clampedW <= 0 || clampedH <= 0) continue;
		targets.push({ text: b.text, x, y, w: clampedW, h: clampedH, confidence: b.confidence });
	}
	return targets
		.sort((a, b) => b.w * b.h - a.w * a.h)
		.slice(0, MAX_CLICK_TARGETS)
		.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Format click targets compactly for the model — one per line, box + text. */
export function formatClickTargets(targets: ClickTarget[], max = 20): string {
	if (targets.length === 0) return "";
	const lines = targets.slice(0, max).map(t => `  (${t.x},${t.y}) ${t.w}x${t.h} "${t.text}"`);
	return `Clickable words (frame px — pass these as live_click x/y):\n${lines.join("\n")}`;
}

/** Remember this reading's click targets for `target`-based live_* calls.
 *  Bumps the target generation so stale glances stop resolving: targets
 *  die with the glance that produced them (frame-bound contract).
 *  Exported for tests to seed the matcher, and used by eye/screenshot. */
export function rememberClickTargets(targets: ClickTarget[]): void {
	clickTargetGen++;
	lastClickTargets = targets.map(t => ({ ...t, gen: clickTargetGen }));
}
/** A remembered click target with its reading generation — targets die with
 *  the glance that produced them unless re-observed (frame-bound contract). */
interface GenerationalTarget extends ClickTarget {
	gen: number;
}

/** Monotonic generation of the last anchored reading (eye/screenshot). */
let clickTargetGen = 0;

/** Junk-word filter for the target pool: symbol-only specks and low-confidence
 *  fragments crowd the 40-cap on dense windows (browser tabs full of mangled
 *  titles) and push real labels out. A word is junk when it has no letter or
 *  digit AND low confidence — real icon labels ("+", "=") survive via the
 *  confidence check only when OCR is sure of them. Exported for tests. */
export function isJunkTargetWord(text: string, confidence: number): boolean {
	if (/[A-Za-z0-9]/.test(text)) return false;
	return confidence < 0.7;
}

/** Resolve a `target` text ("Compose", "Send") to the best remembered click
 *  target. Exact match wins; then word-boundary/phrase matches ("Send"
 *  matches "Send message" but NOT "Resend" or "Sender"); substring is the
 *  last resort. Within a tier, prefers shorter text (a button label beats a
 *  sentence containing the word), then topmost. Only targets from the
 *  CURRENT reading generation are eligible — stale glances never drive
 *  input. Returns frame-px center of the box. */
export function resolveClickTarget(text: string): { x: number; y: number; box: ClickTarget } | null {
	const q = text.trim().toLowerCase();
	if (!q) return null;
	const pool = lastClickTargets.filter(t => (t as GenerationalTarget).gen === clickTargetGen);
	if (pool.length === 0) return null;
	const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wordRe = new RegExp(`\\b${esc}\\b`);
	const tier = (t: string): number => {
		const l = t.toLowerCase();
		if (l === q) return 0;
		if (wordRe.test(l)) return 1;
		if (l.includes(q)) return 2;
		return 3;
	};
	const matches = pool.map(t => ({ t, tier: tier(t.text) })).filter(m => m.tier < 3);
	if (matches.length === 0) return null;
	const best = matches.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier - b.tier;
		if (a.t.text.length !== b.t.text.length) return a.t.text.length - b.t.text.length;
		return a.t.y - b.t.y || a.t.x - b.t.x;
	})[0].t;
	return { x: best.x + Math.round(best.w / 2), y: best.y + Math.round(best.h / 2), box: best };
}

/** --- Guardrails: final-action denylist + password-field detection ------- */

/**
 * Labels that commit an irreversible or externally-visible action. Clicks
 * resolving to these words (or typing that names them) need an explicit
 * human go-ahead — the drive loop refuses fail-closed instead of asking
 * mid-flow (clippy AutomationSafety + nuphus strict-confirm pattern).
 * Substring match on the lowercase label; keep entries word-like so
 * "sender" doesn't trip on "send" — matching is token-aware (see below).
 */
export const FINAL_ACTION_DENYLIST = [
	"send",
	"submit",
	"pay",
	"buy",
	"purchase",
	"checkout",
	"delete",
	"remove",
	"agree",
	"accept",
	"sign out",
	"signout",
	"log out",
	"logout",
	"publish",
	"post",
	"transfer",
	"confirm",
] as const;

/** Tokens in on-screen text that suggest a password/secret field is focused. */
const PASSWORD_HINTS = ["password", "passcode", "secret", "enter your pin", "2fa", "one-time code", "otp"];

/** Token-aware denylist hit: whole-word (or whole-phrase) match, so "sender"
 *  doesn't trip on "send" but 'Click "Send"' does. Exported for tests. */
export function finalActionHit(label: string): string | null {
	const q = label.trim().toLowerCase();
	if (!q) return null;
	const tokens = new Set(q.split(/[^a-z0-9]+/).filter(Boolean));
	for (const entry of FINAL_ACTION_DENYLIST) {
		if (entry.includes(" ")) {
			if (q.includes(entry)) return entry;
		} else if (tokens.has(entry)) {
			return entry;
		}
	}
	return null;
}

/** True when the remembered OCR text looks like a password/secret prompt.
 *  Exported for tests. */
export function looksLikePasswordPrompt(ocrText: string | undefined): boolean {
	if (!ocrText) return false;
	const q = ocrText.toLowerCase();
	return PASSWORD_HINTS.some(h => q.includes(h));
}

/** Last full OCR reading (any of eye/screenshot/verify), kept for the
 *  password-prompt check. Module-level like lastInputFrame. */
let lastOcrText = "";

/** Remember the latest full OCR reading for guardrail checks. */
export function rememberOcrText(text: string): void {
	lastOcrText = text;
}

/**
 * Fail-closed guardrail for injection actions. Returns an error message when
 * the action must NOT run, or null when it may proceed. Checks, in order:
 * 1. `target` text against the final-action denylist (clicking "Send"/"Pay"…);
 * 2. typed/key text that names a final action ("click Send", live_type "pay now");
 * 3. password-prompt context for live_type (typing secrets needs a human).
 * D004 preserved: approval gates still apply — this is an additional refusal
 * layer, not a replacement.
 */
export function guardrailRefusal(action: string, params: { target?: string; keys?: string }): string | null {
	if (params.target) {
		const hit = finalActionHit(params.target);
		if (hit) {
			return `Refused: "${params.target}" matches final-action "${hit}" — this commits an irreversible or externally-visible action. Confirm with Peter out-of-band first, then act yourself.`;
		}
	}
	if ((action === "live_type" || action === "live_key") && params.keys) {
		const hit = finalActionHit(params.keys);
		if (hit) {
			return `Refused: typed text names final-action "${hit}" — this may commit an irreversible action. Confirm with Peter out-of-band first.`;
		}
		if (action === "live_type" && looksLikePasswordPrompt(lastOcrText)) {
			return "Refused: the screen looks like a password/secret prompt — never type secrets via automation. Peter types passwords himself.";
		}
	}
	return null;
}


/** --- Guardrails: restricted apps (terminal / agent CLI) ---------------- */

/**
 * Window classes that host a shell or the agent's own CLI/TUI. Typing or
 * clicking into these is refused fail-closed: the agent already has a bash
 * tool for shell work, and keystrokes into its own terminal risk
 * self-injection (commands executed as Peter, session corruption).
 * Matching is case-insensitive substring on the Wayland app-id / WM_CLASS.
 */
export const RESTRICTED_APP_CLASSES = [
	"kitty",
	"alacritty",
	"foot",
	"wezterm",
	"gnome-terminal",
	"konsole",
	"xterm",
	"terminator",
	"tilix",
	"hyper",
	"iterm",
	"terminal",
	"cmd.exe",
	"powershell",
	"windowsterminal",
] as const;

/** True when the window class belongs to a restricted app. Exported for tests. */
export function restrictedAppHit(winClass: string | undefined): string | null {
	if (!winClass) return null;
	const q = winClass.toLowerCase();
	for (const entry of RESTRICTED_APP_CLASSES) {
		if (q.includes(entry)) return entry;
	}
	return null;
}

/**
 * Fail-closed refusal for live_type/live_click into restricted apps
 * (terminals, agent CLI). live_move/live_key/live_scroll stay allowed —
 * looking and navigating are harmless; only text injection and clicks
 * (which can focus editors/buttons inside the terminal) are refused.
 */
export function restrictedAppRefusal(
	action: string,
	win: { class?: string; title?: string } | undefined,
): string | null {
	if (action !== "live_type" && action !== "live_click") return null;
	const hit = restrictedAppHit(win?.class);
	if (!hit) return null;
	return `Refused: focused window "${win?.title ?? "(untitled)"}" is a ${hit} terminal — use the bash tool for shell work instead of typing/clicking into a terminal. Keystrokes here could self-inject into the agent's own session.`;
}

function modifierRefusal(action: string, modifiers: unknown): string | null {
	if (modifiers === undefined) return null;
	if (action !== "live_drag") return "modifiers is supported only for live_drag.";
	if (!Array.isArray(modifiers) || modifiers.length !== 1 || modifiers[0] !== "shift") {
		return "live_drag modifiers must be exactly ['shift'].";
	}
	return null;
}

/** Status of the continuous observation at input-validation time.
 *  Exported for tests: proves pointer/keyboard actions consult the live
 *  snapshot (not just the last screenshot frame) and refuse a reading whose
 *  scene no longer matches with an actionable code. */
export type ObservationInputStatus =
	| { state: "fresh"; ageMs: number; address: string }
	| { state: "missing" | "superseded" | "stale" | "address_mismatch" | "geometry_mismatch"; detail: string; ageMs: number | null };

/** Live geometry of the focused window, as the cheap focus probe reports it
 *  (`hyprctl activewindow -j` → at/size). Zero size means the backend cannot
 *  report geometry (the X11 driver returns [0,0]); that is "unknown", never a
 *  mismatch, so X11 degrades to address-only identity instead of refusing. */
export interface ActiveGeometry {
	at: [number, number];
	size: [number, number];
}

/** True when a probe actually reported usable geometry. */
export function geometryIsKnown(g: ActiveGeometry | undefined | null): g is ActiveGeometry {
	return !!g && Array.isArray(g.at) && Array.isArray(g.size) && g.size[0] > 0 && g.size[1] > 0;
}

/** Defensive shape check: a safety gate must NEVER throw on malformed data —
 *  an unusable rect degrades to "identity unproven" (wall-clock fallback,
 *  fail-closed) instead of a TypeError mid-injection. */
function rectIsUsable(r: ActiveGeometry | null | undefined): r is ActiveGeometry {
	return (
		!!r &&
		Array.isArray(r.at) && r.at.length === 2 && Number.isFinite(r.at[0]) && Number.isFinite(r.at[1]) &&
		Array.isArray(r.size) && r.size.length === 2 && Number.isFinite(r.size[0]) && Number.isFinite(r.size[1])
	);
}

/** Usable rect from a snapshot: probe-reported windowRect first (authoritative),
 *  else the capture frame's rect; null when neither is usable. */
function snapshotRect(snap: { windowRect?: ActiveGeometry | null; frame?: InputFrame | null }): ActiveGeometry | null {
	const cands: Array<ActiveGeometry | null | undefined> = [
		snap.windowRect ?? null,
		snap.frame ? { at: [snap.frame.atX, snap.frame.atY], size: [snap.frame.physW, snap.frame.physH] } : null,
	];
	for (const c of cands) if (rectIsUsable(c)) return { at: [c.at[0], c.at[1]], size: [c.size[0], c.size[1]] };
	return null;
}

/** Central validity policy for live input. A snapshot stays usable while the
 *  scene it described is still the scene in front of it: un-superseded, same
 *  focused-window ADDRESS, and (when the probe reports geometry) the same
 *  RECT as the anchored frame. This is the human-eye contract — perception
 *  invalidates when the scene moves, not when wall-clock time passes, so a
 *  matching snapshot is accepted at any age and ageMs is reported for
 *  transparency only. Identity that cannot be proven (no anchored frame, or
 *  no reported geometry) falls back to wall-clock expiry, fail-closed.
 *  A focused window that changed address re-anchors from the fresh pre-action
 *  frame when one is supplied. Pure over injected state — exported for tests. */
export function observationInputStatus(input: {
	snapshot: ObservationSnapshot | undefined;
	activeAddress: string | undefined;
	freshFrame: InputFrame | null;
	activeGeometry?: ActiveGeometry | null;
	now?: number;
	maxAgeMs?: number;
}): ObservationInputStatus {
	const now = input.now ?? Date.now();
	const maxAgeMs = input.maxAgeMs ?? 1500;
	const snap = input.snapshot;
	if (!snap) return { state: "missing", detail: "No continuous observation yet — take a live_eye glance first.", ageMs: null };
	if (snap.superseded) return { state: "superseded", detail: "Observation was superseded by a focus change or cancel — re-anchor before driving input.", ageMs: Math.max(0, now - snap.capturedAt) };
	const ageMs = Math.max(0, now - snap.capturedAt);
	const freshFrameMatches = !!input.freshFrame?.address && input.freshFrame.address === input.activeAddress;
	if (snap.address !== input.activeAddress) {
		// Focus moved off the anchored window. A fresh pre-action frame for the
		// NEW address re-anchors cleanly; otherwise refuse (never redirect).
		if (freshFrameMatches) return { state: "fresh", ageMs: 0, address: input.freshFrame!.address! };
		return {
			state: "address_mismatch",
			detail: `Observation is anchored to ${snap.address} but the active window is ${input.activeAddress ?? "none"} — re-anchor before driving input.`,
			ageMs,
		};
	}
	// Same address. Compare scene identity when the probe reports geometry.
	// Prefer the snapshot's probe-reported window rect (authoritative) over the
	// frame's capture rect: a window larger than the monitor is clamped by the
	// compositor, so the capture rect can be smaller than the window itself.
	const geometryKnown = geometryIsKnown(input.activeGeometry);
	const snapRect = snapshotRect(snap);
	const identityUnproven = !snapRect || !geometryKnown;
	const live = geometryKnown ? { at: input.activeGeometry!.at, size: input.activeGeometry!.size } : null;
	const rectMatches =
		identityUnproven ||
		(!!live &&
			snapRect!.at[0] === live.at[0] && snapRect!.at[1] === live.at[1] &&
			snapRect!.size[0] === live.size[0] && snapRect!.size[1] === live.size[1]);
	if (identityUnproven) {
		// Cannot prove scene identity (no anchored rect, or the backend has
		// no usable geometry): fall back to wall-clock expiry — fail-closed.
		if (ageMs <= maxAgeMs) return { state: "fresh", ageMs, address: snap.address };
		if (freshFrameMatches) return { state: "fresh", ageMs: 0, address: input.freshFrame!.address! };
		return { state: "stale", detail: `Continuous observation is ${ageMs}ms old (limit ${maxAgeMs}ms) with no anchored rect to prove identity — refresh the glance before driving input.`, ageMs };
	}
	if (!rectMatches) {
		const g = input.activeGeometry!;
		const wasAt = snapRect ? `@ ${snapRect.at[0]},${snapRect.at[1]} ${snapRect.size[0]}x${snapRect.size[1]}` : "(no anchored rect)";
		return {
			state: "geometry_mismatch",
			detail: `Focused window ${snap.address} moved/resized since the observation (was ${wasAt}; now @ ${g.at[0]},${g.at[1]} ${g.size[0]}x${g.size[1]}) — re-eye before driving input.`,
			ageMs,
		};
	}
	// Identical rects prove the scene is unchanged — accept at any age and
	// report the age for transparency (the human-eye contract).
	return { state: "fresh", ageMs, address: snap.address };
}

/**
 * Validate-before-run (clippy validate-before-run pattern): every check that
 * can fail WITHOUT touching the desktop runs here, before any backend
 * subprocess. Bounds, target resolution, stale frame, and both guardrails.
 * Returns { ok } or { error, code }. Exported for tests.
 */
export function validateInjection(params: {
	action: string;
	x?: number;
	y?: number;
	x2?: number;
	y2?: number;
	target?: string;
	keys?: string;
	modifiers?: unknown;
	frame: { scaledW: number; scaledH: number; kind: string; address?: string } | null;
	focusedAddress: string | undefined;
	observation?: ObservationInputStatus;
}): { ok: true; tx?: number; ty?: number } | { ok: false; error: string; code: string } {
	const isPointer = params.action === "live_move" || params.action === "live_click" || params.action === "live_drag";
	// 1. Guardrails first (cheapest, no frame needed).
	const refusal = guardrailRefusal(params.action, { target: params.target, keys: params.keys });
	if (refusal) return { ok: false, error: refusal, code: "guardrail_refusal" };
	const modifiersError = modifierRefusal(params.action, params.modifiers);
	if (modifiersError) return { ok: false, error: modifiersError, code: "invalid_modifiers" };
	// Restricted-app check needs the window — represented here by class/title
	// passed via keys-free params; the live path re-checks with the real win.
	// 1b. Continuous-observation freshness: when the caller supplies the
	// snapshot status, a stale/superseded/mismatched reading refuses with an
	// actionable code instead of driving from an old frame.
	if (params.observation && params.observation.state !== "fresh") {
		const obs = params.observation;
		const code = obs.state === "missing" ? "no_observation" : obs.state === "stale" ? "observation_stale" : obs.state === "superseded" ? "observation_superseded" : obs.state === "geometry_mismatch" ? "observation_geometry_mismatch" : "observation_mismatch";
		return { ok: false, error: obs.detail, code };
	}
	// 2. Pointer branches need a frame + coordinates.
	if (isPointer) {
		if (!params.frame) {
			return {
				ok: false,
				error: "No screenshot frame yet. Take a desktop_control screenshot of the target window (default active_window) first — live pointer coordinates are frame px of that image.",
				code: "no_frame",
			};
		}
		if (params.frame.kind === "window" && params.frame.address !== params.focusedAddress) {
			return {
				ok: false,
				error: "The focused window changed since the last screenshot. Retake a screenshot of the target window, then retry.",
				code: "frame_stale",
			};
		}
		let tx = params.x;
		let ty = params.y;
		if (params.target) {
			const hit = resolveClickTarget(params.target);
			if (!hit) {
				return {
					ok: false,
					error: `No remembered OCR word matches "${params.target}". Take an eye/screenshot of the window first (vision sessions: pass ocr:true so words are read), then match against its Clickable words list (e.g. "Compose", "Send").`,
					code: "target_not_found",
				};
			}
			tx = hit.x;
			ty = hit.y;
		}
		if (tx === undefined || ty === undefined) {
			return {
				ok: false,
				error: `${params.action} requires x and y (frame px from the last screenshot), or target (OCR word from the last eye/screenshot).`,
				code: "missing_xy",
			};
		}
		// 3. Out-of-bounds reject (fail-closed — never inject blind coords).
		if (tx < 0 || ty < 0 || tx >= params.frame.scaledW || ty >= params.frame.scaledH) {
			return {
				ok: false,
				error: `Coordinates (${tx},${ty}) are outside the ${params.frame.scaledW}x${params.frame.scaledH} frame — re-eye and re-aim. Refusing to inject blind.`,
				code: "out_of_bounds",
			};
		}
		if (params.action === "live_drag" && (params.x2 === undefined || params.y2 === undefined)) {
			return { ok: false, error: "live_drag requires x,y and x2,y2 (frame px).", code: "missing_xy2" };
		}
		if (
			params.action === "live_drag" &&
			params.x2 !== undefined &&
			params.y2 !== undefined &&
			(params.x2 < 0 || params.y2 < 0 || params.x2 >= params.frame.scaledW || params.y2 >= params.frame.scaledH)
		) {
			return {
				ok: false,
				error: `Drag end (${params.x2},${params.y2}) is outside the ${params.frame.scaledW}x${params.frame.scaledH} frame — re-eye and re-aim.`,
				code: "out_of_bounds",
			};
		}
		return { ok: true, tx, ty };
	}
	// 3b. Keyboard branches need their payload.
	if (params.action === "live_type" && !params.keys) {
		return { ok: false, error: "live_type requires 'keys' (the text to type).", code: "missing_text" };
	}
	if (params.action === "live_key" && !params.keys) {
		return { ok: false, error: "live_key requires 'keys' (e.g. Return, ctrl+l, super+Return, space).", code: "missing_keys" };
	}
	return { ok: true };
}

type LiveImageBlock = Extract<AgentToolResult["content"][number], { type: "image" }>;

interface LiveCapture {
	text: string;
	image?: LiveImageBlock;
	frame: InputFrame | null;
	/** Scaled frame image on disk (for late OCR in hidden steers). */
	framePath: string;
}

/** Capture the focused window (or full display) and downscale to the vision frame. */
async function captureLiveFrame(lead: string): Promise<LiveCapture | { error: string }> {
	const driver = detectPlatformDriver();
	if (!isSupportedDriver()) return { error: `live input is not supported on this platform yet (${driver.label}).` };
	const win = await getDriverActiveWindow();
	const geometry =
		win && win.size[0] > 0 && win.size[1] > 0 ? `${win.at[0]},${win.at[1]} ${win.size[0]}x${win.size[1]}` : undefined;
	const stamp = Date.now();
	const rawPath = path.join(os.tmpdir(), `aerys-live-${stamp}-raw.png`);
	const scaledPath = path.join(os.tmpdir(), `aerys-live-${stamp}.png`);
	const cap = await driver.capture.capture(rawPath, geometry);
	if (cap.code !== 0) return { error: `capture failed (${driver.id}): ${cap.stderr}` };
	const conv = await runCmd("convert", [rawPath, "-resize", "1280x800>", scaledPath]);
	const finalPath = conv.code === 0 && fs.existsSync(scaledPath) ? scaledPath : rawPath;
	const frame = await rememberFrame(win, geometry, rawPath, finalPath);
	let base64 = "";
	try {
		base64 = (await fs.promises.readFile(finalPath)).toString("base64");
	} catch {}
	const where = win
		? `focused window "${win.title}" (${win.class})`
		: geometry
			? `region ${geometry}`
			: "fullscreen display";
	return {
		text: `${lead} Screenshot of ${where}${frame ? ` — frame ${frame.scaledW}x${frame.scaledH} (from ${frame.physW}x${frame.physH}px) — subsequent live_* coordinates use this frame.` : ""}.`,
		image: base64 ? { type: "image" as const, data: base64, mimeType: "image/png" as const } : undefined,
		frame,
		framePath: finalPath,
	};
}

/** --- Drive loop: settle (wait-for-quiet) ------------------------------ */

/** A cheap UI-state fingerprint used to detect "the screen has stopped
 *  changing" after an action. Combines the active-window identity with a
 *  downscaled capture (hashed) so both layout shifts and content repaints
 *  are caught without full OCR on every poll. */
async function uiFingerprint(): Promise<string> {
	const win = isSupportedDriver() ? await getDriverActiveWindow().catch(() => undefined) : undefined;
	const stamp = Date.now();
	const rawPath = path.join(os.tmpdir(), `aerys-settle-${stamp}.png`);
	let img = "";
	try {
		const cap = await detectPlatformDriver().capture.capture(rawPath).catch(() => ({ code: 1, stderr: "capture threw" }));
		if (cap.code === 0 && fs.existsSync(rawPath)) {
			// Resize to a tiny grayscale-ish hash input so repaints dominate
			// the digest and absolute scale doesn't matter. Short timeout:
			// a wedged compositor (locked screen) must degrade to
			// window-identity, never hang the drive loop.
			const small = path.join(os.tmpdir(), `aerys-settle-${stamp}-small.png`);
			const conv = await runCmd("convert", [rawPath, "-resize", "160x100!", small], { timeout: 4000 });
			if (conv.code === 0 && fs.existsSync(small)) {
				const buf = await fs.promises.readFile(small);
				img = hashBytes(buf);
			}
			fs.rm(rawPath, { force: true }, () => {});
			fs.rm(small, { force: true }, () => {});
		}
	} catch {
		// best-effort; fingerprint degrades to window identity only
	}
	return `${win?.address ?? ""}|${win?.title ?? ""}|${img}`;
}

/** Tiny deterministic hash (FNV-1a) over a byte buffer. Exported for tests. */
export function hashBytes(buf: Uint8Array): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < buf.length; i++) {
		h ^= buf[i];
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0 ? h.toString(16) : "0";
}

/**
 * Wait for the interface to stop changing ("settle"), giving up after
 * `withinMs`. Polls every `intervalMs`; returns the number of polls that
 * showed a *change* (0 = already quiet). Used by the drive loop between
 * steps so the next eye/verify read sees the settled UI — clippy's
 * settle(within:) pattern.
 */
export async function settle(withinMs = 2000, intervalMs = 250): Promise<number> {
	const t0 = Date.now();
	let prev = await uiFingerprint();
	let changes = 0;
	while (Date.now() - t0 < withinMs) {
		await new Promise(r => setTimeout(r, intervalMs));
		const cur = await uiFingerprint();
		if (cur !== prev) {
			changes++;
			prev = cur;
		} else if (changes > 0) {
			// One stable sample after the last change = quiet.
			break;
		}
	}
	return changes;
}

/** Identity used to guard desktop injection against a focus change. */
export type FocusedWindowIdentity = Pick<DesktopWindowInfo, "address" | "class" | "title">;

/** Return a fail-closed refusal unless the active window is exactly the expected client. */
export function focusGuardRefusal(expectedWindowAddress: string | undefined, actual: FocusedWindowIdentity | undefined): string | null {
	if (!expectedWindowAddress) return "Refused: no expected focused-window address is available for this input batch.";
	if (actual?.address === expectedWindowAddress) return null;
	const found = actual ? `\"${actual.title}\" (${actual.class}) @ ${actual.address}` : "no focused window";
	return `Refused: focused window changed before input injection — expected @ ${expectedWindowAddress}, found ${found}. Re-eye or refocus the target, then retry.`;
}

/** Check the compositor immediately before a command that emits desktop input. */
export async function assertInputFocus(
	expectedWindowAddress: string | undefined,
	activeWindow: () => Promise<FocusedWindowIdentity | undefined> = getDriverActiveWindow,
): Promise<string | null> {
	const actual = await activeWindow().catch(() => undefined);
	return focusGuardRefusal(expectedWindowAddress, actual);
}

/** Run argv steps sequentially with a small inter-step sleep and a fresh focus assertion before every input command. */
export async function runSteps(
	steps: string[][],
	interStepMs = 30,
	expectedWindowAddress?: string,
	assertFocus: (expectedWindowAddress: string | undefined) => Promise<string | null> = assertInputFocus,
): Promise<string | null> {
	for (const argv of steps) {
		const focusError = await assertFocus(expectedWindowAddress);
		if (focusError) return focusError;
		const res = await runCmd(argv[0], argv.slice(1), { timeout: 8000 });
		if (res.code !== 0) return `\"${argv[0]} ${argv.slice(1).join(" ")}\" failed: ${res.stderr || res.stdout}`;
		if (interStepMs > 0) await new Promise(r => setTimeout(r, interStepMs));
	}
	return null;
}
/** Emergency button/key release after a guarded drag aborts. Never use for a normal input step. */
async function runInputRelease(argv: string[]): Promise<string | null> {
	const res = await runCmd(argv[0], argv.slice(1), { timeout: 8000 });
	return res.code === 0 ? null : `\"${argv[0]} ${argv.slice(1).join(" ")}\" failed: ${res.stderr || res.stdout}`;
}


/** Drag sequencing with an injected runner for tests; cleanup never inherits cancellation. */
export async function runDragWithCleanup(
	options: { backend: "ydotool" | "xdotool"; shift: boolean; start: string[]; moves: string[][] },
	runStep: (argv: string[]) => Promise<string | null>,
	signal?: AbortSignal,
	releaseStep: (argv: string[]) => Promise<string | null> = runStep,
): Promise<string | null> {
	const ydo = options.backend === "ydotool";
	const shiftDown = ydo ? ydoKeyEvents(["42:1"]) : ["xdotool", "keydown", "Shift_L"];
	const shiftUp = ydo ? ydoKeyEvents(["42:0"]) : ["xdotool", "keyup", "Shift_L"];
	const mouseDown = ydo ? ydoClickButton(YDO_DOWN) : ["xdotool", "mousedown", "1"];
	const mouseUp = ydo ? ydoClickButton(YDO_UP) : ["xdotool", "mouseup", "1"];
	let releaseMouse = false;
	let releaseShift = false;
	let failure: string | null = null;
	const cleanupFailures: string[] = [];
	const checkAbort = () => {
		if (signal?.aborted) throw new Error("live_drag aborted.");
	};
	const step = async (argv: string[]) => {
		checkAbort();
		const error = await runStep(argv);
		if (error) throw new Error(error);
		checkAbort();
	};
	const release = async (label: string, argv: string[]) => {
		try {
			// Releases are the sole focus-guard exception: if focus changed after
			// a held button/key, failing closed would leave global input stuck.
			const error = await releaseStep(argv);
			if (error) cleanupFailures.push(`${label}: ${error}`);
		} catch (error) {
			cleanupFailures.push(`${label}: ${String(error)}`);
		}
	};
	try {
		// An empty start (ydotool path pre-aims via the compositor anchor) is
		// not a step — spawning an empty argv is a hard error, not a no-op.
		if (options.start.length) await step(options.start);
		if (options.shift) {
			// A failed command may still have injected its down event.
			releaseShift = true;
			await step(shiftDown);
		}
		releaseMouse = true;
		await step(mouseDown);
		for (const move of options.moves) await step(move);
	} catch (error) {
		failure = String(error);
	} finally {
		if (releaseMouse) await release("mouse up", mouseUp);
		if (releaseShift) await release("Shift up", shiftUp);
	}
	if (cleanupFailures.length) {
		return `${failure ? `${failure} ` : ""}live_drag cleanup failed: ${cleanupFailures.join("; ")}. Mouse or Shift may still be held; release them before retrying.`;
	}
	return failure ?? (signal?.aborted ? "live_drag aborted." : null);
}

/**
 * Type text trying backends in chain order until one succeeds.
 * ASCII goes direct (ydotool type / wtype text / xdotool type); non-ASCII
 * pastes via wl-copy + Ctrl+V (ydotool) or wl-copy + Ctrl+V via backend keys.
 * Returns null on success, else the last error.
 */
async function typeTextWith(chain: LiveBackend[], text: string, expectedWindowAddress: string): Promise<string | null> {
	let lastErr: string | null = null;
	for (const backend of chain) {
		if (backend === "ydotool") {
			if (isDirectTypeable(text)) {
				const fail = await runSteps([["ydotool", "type", text]], 0, expectedWindowAddress);
				if (!fail) return null;
				lastErr = fail;
				continue;
			}
			const copy = await runCmd("wl-copy", [text]);
			if (copy.code !== 0) {
				lastErr = `wl-copy failed: ${copy.stderr}`;
				continue;
			}
			const fail = await runSteps([["ydotool", "key", "-d", "24", ...YDO_CTRL_V]], 0, expectedWindowAddress);
			if (!fail) return null;
			lastErr = fail;
			continue;
		}
		const lines = splitForEnterTyping(text);
		let ok = true;
		let err: string | null = null;
		for (let i = 0; i < lines.length && ok; i++) {
			if (lines[i]) {
				const argv = backend === "xdotool" ? ["xdotool", "type", "--delay", "40", lines[i]] : ["wtype", lines[i]];
				const fail = await runSteps([argv], 0, expectedWindowAddress);
				if (fail) {
					ok = false;
					err = fail;
				}
			}
			if (ok && i < lines.length - 1) {
				const argv = backend === "xdotool" ? ["xdotool", "key", "--clearmodifiers", "Return"] : ["wtype", "-k", "Return"];
				const fail = await runSteps([argv], 0, expectedWindowAddress);
				if (fail) {
					ok = false;
					err = fail;
				}
			}
		}
		if (ok) return null;
		lastErr = err;
	}
	return lastErr;
}

/**
 * Send a key chord spec ("Return", "ctrl+l", "super+Return") trying backends
 * in chain order until one succeeds. Returns null on success, else last error.
 */
async function keyTextWith(chain: LiveBackend[], spec: string, expectedWindowAddress: string): Promise<string | null> {
	let lastErr: string | null = null;
	for (const backend of chain) {
		if (backend === "ydotool") {
			const events = specToYdotoolEvents(spec);
			if ("error" in events) {
				lastErr = events.error;
				continue;
			}
			const fail = await runSteps([ydoKeyEvents(events)], 30, expectedWindowAddress);
			if (!fail) return null;
			lastErr = fail;
		} else if (backend === "xdotool") {
			const names = specToXdotoolArgs(spec);
			if ("error" in names) {
				lastErr = names.error;
			continue;
			}
			const fail = await runSteps([["xdotool", "key", "--clearmodifiers", ...names]], 30, expectedWindowAddress);
			if (!fail) return null;
			lastErr = fail;
		} else {
			let ok = true;
			let err: string | null = null;
			for (const token of spec.trim().split(/\s+/)) {
				const chord = wtypeChord(token);
				if ("error" in chord) {
					ok = false;
					err = chord.error;
					break;
				}
				const fail = await runSteps([chord.argv], 30, expectedWindowAddress);
				if (fail) {
					ok = false;
					err = fail;
					break;
				}
			}
			if (ok) return null;
			lastErr = err;
		}
	}
	return lastErr;
}
/** Inter-step pause (ms) for a live_scroll burst by reading cadence.
 *  Exported for tests. The guard assertion before every step stays
 *  mandatory — speed only shortens the pause between guarded steps. */
export function scrollBurstIntervalMs(speed: "slow" | "normal" | "fast" | undefined): number {
	switch (speed) {
		case "slow": return 600;
		case "fast": return 80;
		default: return 250;
	}
}

/** Validated scroll-burst plan: clamped step count + cadence + sampling flag.
 *  Exported for tests. Invalid speeds fall back to normal (never refuse —
 *  the burst must stay fail-operational on the cadence axis; safety lives
 *  in the per-step focus guard, not the speed knob). */
export function scrollBurstPlan(input: { count?: number; scrollSpeed?: string; observeDuringScroll?: boolean }): {
	steps: number;
	intervalMs: number;
	speed: "slow" | "normal" | "fast";
	sample: boolean;
} {
	const steps = Math.max(1, Math.min(input.count ?? 1, 20));
	const speed = input.scrollSpeed === "slow" || input.scrollSpeed === "fast" ? input.scrollSpeed : "normal";
	return { steps, intervalMs: scrollBurstIntervalMs(speed), speed, sample: input.observeDuringScroll ?? true };
}

/** One per-step progress sample in a scroll burst: cheap change fingerprint
 *  taken between guarded steps so the eye reads WHILE the view moves. */
export interface ScrollBurstSample {
	step: number;
	at: number;
	/** Fingerprint of the window right after this step (null when uncaptured). */
	fingerprint: string | null;
	/** True when the fingerprint differs from the previous sample. */
	changed: boolean;
}

/** Run a scroll burst one guarded step at a time with an adjustable cadence.
 *  Each step re-asserts the exact focused-window address BEFORE injecting
 *  (fail-closed); between steps an optional cheap fingerprint samples visual
 *  progress without forcing a full settle. Aborts on focus loss, backend
 *  failure, or cancellation — never emits input after a mismatch. Exported
 *  for tests via injectable step/sample/assert hooks (no desktop I/O). */
export async function runScrollBurst(
	steps: string[][],
	options: {
		intervalMs: number;
		sample: boolean;
		expectedWindowAddress: string;
		signal?: AbortSignal;
		run?: (argv: string[]) => Promise<string | null>;
		sampleFrame?: () => Promise<string | null>;
		assertFocus?: (expected: string | undefined) => Promise<string | null>;
	},
): Promise<{ failure: string | null; completedSteps: number; samples: ScrollBurstSample[] }> {
	const run = options.run ?? (async argv => {
		const res = await runCmd(argv[0], argv.slice(1), { timeout: 8000 });
		return res.code === 0 ? null : `"${argv[0]} ${argv.slice(1).join(" ")}" failed: ${res.stderr || res.stdout}`;
	});
	const assertFocus = options.assertFocus ?? assertInputFocus;
	const samples: ScrollBurstSample[] = [];
	let prev: string | null | undefined;
	let completedSteps = 0;
	for (let i = 0; i < steps.length; i++) {
		if (options.signal?.aborted) return { failure: `Scroll burst aborted before step ${i + 1}.`, completedSteps, samples };
		const focusError = await assertFocus(options.expectedWindowAddress);
		if (focusError) return { failure: focusError, completedSteps, samples };
		const stepFailure = await run(steps[i]);
		if (stepFailure) return { failure: stepFailure, completedSteps, samples };
		completedSteps++;
		if (options.sample && options.sampleFrame) {
			let fp: string | null = null;
			try {
				fp = await options.sampleFrame();
			} catch {
				fp = null;
			}
			samples.push({ step: i + 1, at: Date.now(), fingerprint: fp, changed: prev !== undefined && fp !== prev });
			prev = fp;
		}
		if (i < steps.length - 1 && options.intervalMs > 0) {
			await new Promise(r => setTimeout(r, options.intervalMs));
		}
	}
	return { failure: null, completedSteps, samples };
}

/** Execute one live_* action (module-level so the execute() switch stays tiny). */
async function executeLiveAction(
	action: string,
	params: DesktopControlParams,
	session?: ToolSession,
	signal?: AbortSignal,
): Promise<AgentToolResult> {
	// Identity of THIS injection step — used both by the abort gate (does the
	// incoming attempt repeat the stuck step?) and by the observers (does the
	// streak count this step or restart?).
	const stepKey = driveLoopStepKey(action, params);
	const okText = (text: string, extra?: Record<string, unknown>): AgentToolResult => ({
		content: [{ type: "text", text }],
		details: { driveLoop: driveLoopStatus(), ...(extra ?? {}) },
	});
	const okObserve = (actionName: string, text: string, extra?: Record<string, unknown>): AgentToolResult => {
		driveLoopObserve(actionName, true, actionName === "live_scroll" ? (params.direction ?? undefined) : undefined, stepKey);
		return okText(text, extra);
	};
	const errText = (text: string, code?: string): AgentToolResult => ({
		content: [{ type: "text", text }],
		details: code ? { error: code, driveLoop: driveLoopStatus() } : { driveLoop: driveLoopStatus() },
	});
	const errObserve = (actionName: string, text: string, code?: string): AgentToolResult => {
		driveLoopObserve(actionName, false, actionName === "live_scroll" ? (params.direction ?? undefined) : undefined, stepKey);
		return errText(text, code);
	};

	if (action === "live_mode_on") {
		liveModeEnabled = true;
		// Preauthorization: the model may ask to have specific injection kinds
		// approved up-front (D004 per-kind gate, satisfied in advance) so a
		// multi-step automation flow doesn't deadlock on a mid-flow prompt.
		// Only the six injection kinds are accepted — mode toggles, probe and
		// live_eye stay read-tier and unrelated.
		if (params.preAuthorize?.length) {
			for (const k of params.preAuthorize) liveAuthorizedKinds.add(k);
		}
		// Enabling app-control is the natural moment to make sure the input
		// daemon is actually up — otherwise every live_* action fails with a
		// "no-daemon" error until someone starts ydotoold by hand. Best-effort:
		// if it can't start (no uinput/udev), the probe/actions will say so.
		const daemonUp = await ensureYdotoold();
		// Phase 3: adaptive observation refresher — while app-control is ON,
		// cheap probe-only ticks keep the continuous observation current so
		// agent turn latency no longer expires the human-eye freshness gate.
		startObservationRefresher();
		const pre = params.preAuthorize?.length ? ` Pre-authorized: ${params.preAuthorize.join(", ")}.` : "";
		return okText(
			`App-control mode is ON. live_* actions may drive the focused window on your real desktop. Peter stays in control: the first use of each action kind prompts for approval.${pre}${daemonUp ? "" : " Warning: ydotool input daemon could not be started — injection may fail (see live_backend_probe)."}`,
			{ liveMode: true, ydotoold: daemonUp, preAuthorized: params.preAuthorize ?? [] },
		);
	}
	if (action === "live_mode_off") {
		liveModeEnabled = false;
		stopObservationRefresher();
		return okText("App-control mode OFF — live input disabled.", { liveMode: false });
	}
	if (action === "live_mode_status" || action === "live_backend_probe") {
		const probe = await probeBackends();
		const driver = detectPlatformDriver();
		const win = await getDriverActiveWindow().catch(() => undefined);
		const pointer = resolveBackend(probe, win?.xwayland, "pointer");
		const keyboard = resolveBackend(probe, win?.xwayland, "keyboard");
		const frame = lastInputFrame;
		const lines = [
			`App-control mode: ${liveModeEnabled ? "ON" : "OFF"}${obsRefresherRunning ? " (observation refresher running)" : ""}`,
			`Platform: ${driver.label} (driver: ${driver.id})`,
			`Backends: ydotool=${probe.ydotool} (daemon: ${probe.ydotoold ? "up" : "DOWN"}) | xdotool=${probe.xdotool} | wtype=${probe.wtype}`,
			`Focused window: ${win ? `"${win.title}" (${win.class}) — ${win.xwayland ? "XWayland" : "native Wayland"}` : "none (focus one first)"}`,
			`Resolved backend → pointer: ${pointer}${pointer === "no-daemon" ? " — start ydotoold / add the uinput udev rule" : ""}; keyboard/type: ${keyboard}`,
			`Authorized kinds: ${liveAuthorizedKinds.size ? [...liveAuthorizedKinds].join(", ") : "(none — first use of each kind prompts Peter)"}`,
			`Last screenshot frame: ${frame ? `${frame.kind} ${frame.scaledW}x${frame.scaledH}${frame.address ? ` @ ${frame.address}` : ""}` : "none — screenshot the target window first"}`,
		];
		return okText(lines.join("\n"), {
			liveMode: liveModeEnabled,
			platform: driver.id,
			probe,
			focused: win,
			resolvedPointer: pointer,
			resolvedKeyboard: keyboard,
			frame,
		});
	}

	// ---- injection actions: opt-in gate + drive-loop abort gate ----
	if (!liveModeEnabled) {
		return errText(
			'App-control mode is OFF (D004 safety gate). Enable it with action "live_mode_on" first — live input drives your real desktop.',
			"mode_off",
		);
	}
	const abort = driveLoopAbortReason(stepKey);
	if (abort) {
		return errText(
			`Drive-loop guardrail tripped before "${action}": ${abort}.`,
			"drive_loop_abort",
		);
	}
	// Fail-closed final-action / password guardrail (phase-3): refuse before
	// any backend work. Applies to live_click (target), live_type/live_key
	// (keys naming a final action, or secrets into a password prompt).
	const refusal = guardrailRefusal(action, { target: params.target, keys: params.keys });
	if (refusal) {
		return errText(refusal, "guardrail_refusal");
	}
	const probe = await probeBackends();
	const win = await getDriverActiveWindow();
	if (!win || !win.address) {
		return errText(
			"No focused window to drive. Focus the target app first (focus_window / hyprctl) or click it yourself.",
			"no_focused_window",
		);
	}
	// Restricted-app guardrail: never type/click into a terminal or the
	// agent's own CLI — the bash tool covers shell work, and keystrokes here
	// risk self-injection. Checked after focus so the refusal names the app.
	const appRefusal = restrictedAppRefusal(action, win);
	if (appRefusal) {
		return errText(appRefusal, "guardrail_refusal");
	}
	const isPointer = action === "live_move" || action === "live_click" || action === "live_drag";
	const kind: InputKind =
		isPointer || action === "live_scroll" ? "pointer" : action === "live_type" ? "type" : "keyboard";
	let backend = resolveBackend(probe, win.xwayland, kind);
	let chain = resolveBackendChain(probe, win.xwayland, kind);
	if (backend === "no-daemon") {
		// One-shot recovery: bring the daemon up on demand so the first
		// injection works without Peter having to start ydotoold by hand.
		const daemonUp = await ensureYdotoold();
		if (!daemonUp) {
			return errText(
				"ydotool is installed but ydotoold (its daemon) could not be started. Check the uinput udev rule and that you're in the 'input' group, then retry.",
				"no_daemon",
			);
		}
		// Daemon came up: re-resolve the backend with fresh probe data.
		const reProbe = await probeBackends();
		backend = resolveBackend(reProbe, win.xwayland, kind);
		chain = resolveBackendChain(reProbe, win.xwayland, kind);
		if (backend === "no-daemon" || backend === "none") {
			return errText("Input backend unavailable even after starting ydotoold.", "no_daemon");
		}
	}
	if (backend === "none") {
		return errText(
			`No input backend for a ${win.xwayland ? "XWayland" : "native-Wayland"} window: install ydotool + ydotoold (A1) or wtype (keyboard-only). Run live_backend_probe for the full picture.`,
			"no_backend",
		);
	}

const verify = params.verify !== false;
	const verifyStartedAt = Date.now();
const withVerify = async (lead: string, extra?: Record<string, unknown>, expectedInsertion?: string): Promise<AgentToolResult> => {
	// Drive-loop bookkeeping: reaching verify means the injection ran.
	// Central success observation for every live_* branch (clippy pattern).
	driveLoopObserve(action, true, action === "live_scroll" ? (params.direction ?? undefined) : undefined, stepKey);
	if (!verify) return okText(lead, extra);
	// Drive loop: let the interface settle after the action before the
	// verify read, so the verify frame reflects the settled UI (clippy's
	// settle-within pattern) rather than a half-repainted frame. Fast
	// path first (one fingerprint + one change-budgeted re-sample):
	// cheap reads like key/type land here; slower changes still settle
	// via the capped loop. LIVE_SETTLE_MS overrides the default 800ms.
	const settleMs = Number(process.env.LIVE_SETTLE_MS ?? 800);
	const settleChanges = await settle(settleMs, 250);
	// Sweep the previous verify frame first (same ephemerality contract as
	// the eye glance — context keeps ~1 verify frame across a flow).
	const swept = (await session?.dropLiveVerifyImages?.()) ?? 0;
	const cap = await captureLiveFrame(lead);
	if ("error" in cap) return okText(`${lead} (verify screenshot failed: ${cap.error})`, extra);
	let insertion: Record<string, unknown> | undefined;
	if (expectedInsertion !== undefined) {
		const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
		const wanted = normalize(expectedInsertion);
		const token = wanted.replace(/\s+/g, "");
		// A field value can wrap and re-read in the downscaled verify frame, so
		// its OCR is unreliable exactly when the value is long enough to matter.
		// The verdict therefore comes from a NATIVE-resolution read of the field
		// row; the frame reading is corroborating evidence only. Locate the row
		// by the token's frame word box, falling back to the pointer (which is
		// not the text caret) only when no word box can be found.
		let frameText = "";
		let frameWords: OcrWordBox[] | undefined;
		if (cap.framePath) {
			const ocr = await ocrFrame(cap.framePath, {});
			frameText = ocr.text;
			frameWords = ocr.words;
		}
		const frameSeen = normalize(frameText).replace(/\s+/g, "").includes(token);
		let nativeText: string | null = null;
		let nativeAnchor: "frame_word" | "pointer" | "none" = "none";
		try {
			if (lastInputFrame && lastInputFrame.scaledW > 0) {
				const fx = lastInputFrame.physW / lastInputFrame.scaledW;
				const fy = lastInputFrame.physH / lastInputFrame.scaledH;
				const hit = (frameWords ?? []).find(w => normalize(w.text).replace(/\s+/g, "").includes(token));
				let screen: { x: number; y: number } | null = null;
				let boxLeft = 460;
				let boxAbove = 20;
				if (hit) {
					screen = { x: lastInputFrame.atX + hit.x * fx, y: lastInputFrame.atY + hit.y * fy };
					boxLeft = 16;
					boxAbove = Math.round(hit.h * fy) + 12;
					nativeAnchor = "frame_word";
				} else {
					const caret = await detectPlatformDriver().capture.cursorPos();
					if (caret) {
						screen = caret;
						nativeAnchor = "pointer";
					}
				}
				if (screen) {
					nativeText = await ocrRegionNative(
						insertionProbeRegion(lastInputFrame, screen, {
							left: boxLeft,
							right: lastInputFrame.physW,
							above: boxAbove,
							below: 30,
						}),
					);
				}
			}
		} catch {
			// Native confirmation is best-effort; the frame reading still stands.
		}
		const nativeSeen = nativeText !== null && normalize(nativeText).replace(/\s+/g, "").includes(token);
		const verdict = insertionVerdict({
			nativeSeen,
			frameSeen,
			rowLocated: nativeText !== null && nativeAnchor === "frame_word",
		});
		insertion = {
			expectedText: expectedInsertion,
			verified: verdict,
			nativeVerified: nativeText !== null ? nativeSeen : null,
			frameSeen,
			nativeAnchor,
			detectedText: nativeText ?? frameText,
			nativeText,
			frameText,
			method: nativeText !== null ? "native_field_row_ocr" : "settled_frame_ocr",
			windowAddress: win.address,
		};
	}
		// Like live_eye: deliver the full verify capture (OCR text for a
		// visionless model, pixels+OCR for a vision-capable one) as a hidden
		// steer; the tool result stays a tiny one-liner.
		const steerParts: string[] = [
			cap.text,
			`Verify frame after the live input action (ephemeral — replaced next verify;${swept > 0 ? ` swept ${swept} older verify frame(s)` : " no older verify frames in context"}${settleChanges > 0 ? `; settled after ${settleChanges} change(s)` : " (UI was already quiet)"}).`,
		];
		const modelSeesImages = session?.supportsVision?.() ?? true;
		if (!modelSeesImages) {
			// The visionless model can't see pixels at all — give it the OCR
			// text layer so it can still confirm the effect of the action.
			const ocrPath = cap.framePath;
			if (ocrPath) {
				const ocr = await ocrFrame(ocrPath, {});
				steerParts.unshift(
					ocr.text
						? `On-screen text after the action (${ocr.text.length} chars, tesseract ${ocr.mode ?? "native"}):`
						: "OCR produced no text after the action (frame may contain no readable text).",
				);
				if (ocr.text) {
					steerParts.push(ocr.text.length > 8000 ? `${ocr.text.slice(0, 8000)}\n…[truncated]` : ocr.text);
					// Durable copy: live-verify steers are swept like eye glances.
					CameraWatchLoop.recordExternalOcr(ocr.text, "verify");
					rememberOcrText(ocr.text);
				}
			}
		}
		const steerContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
			{ type: "text", text: steerParts.join("\n") },
		];
		if (modelSeesImages && cap.image) {
			steerContent.push({ type: "image", data: cap.image.data, mimeType: cap.image.mimeType });
		}
		let attached = false;
		if (session && "sendCustomMessage" in session) {
			try {
				await session.sendCustomMessage?.(
					{
						// Same mechanism as eye-glance: hidden steer, no turn trigger.
						customType: "live-verify",
						content: steerContent,
						display: false,
						details: { liveVerify: { at: Date.now() }, frame: cap.frame },
						attribution: "agent",
					},
					{ deliverAs: "steer", triggerTurn: false },
				);
				attached = true;
			} catch {
				// Fire-and-forget; fall back to inline below if the session is
				// shutting down.
			}
		}
		// The verify capture re-anchors the observation (it is the freshest
		// address-exact reading); hidden-steer ephemerality is unchanged.
		// win already carries the probe-reported live rect, so the anchor is
		// crop-independent exactly like the eye/screenshot sites.
		const reanchor: Record<string, unknown> = cap.frame?.address
			? anchorLiveObservation([
					{
						frame: cap.frame,
						windowRect: win.size[0] > 0 && win.size[1] > 0 ? { at: win.at, size: win.size } : undefined,
					},
				])
			: {};
		// Structured verification (continuous control): freshness, focus
		// identity, capture timing, and settle result ride in details so a
		// caller can PROVE the observation was fresh, not just assume it.
		const snapshot = liveObservation.get();
		const verification = {
			observationAgeMs: snapshot ? Math.max(0, Date.now() - snapshot.capturedAt) : null,
			observationAddress: snapshot?.address ?? null,
			observationGeneration: snapshot?.generation ?? null,
			ocrConfidence: snapshot?.ocrConfidence ?? null,
			focusedAddress: win.address,
			focusedTitle: win.title,
			focusedClass: win.class,
			settleChanges,
			verifyMs: Date.now() - verifyStartedAt,
		};
		return okText(
			`${lead}${attached ? " — verify frame attached for the model." : " (verify frame could not be attached; verify:false to skip)"}`,
			{ success: true, frame: cap.frame, steerAttached: attached, swept, verification, ...(extra ?? {}), ...(insertion ? { insertion } : {}), ...reanchor },
		);
	};


	// Validate-before-run: every fail-without-touching check (guardrails,
	// frame presence/staleness, target resolution, bounds) runs BEFORE any
	// backend subprocess. Failures stop and ask — nothing is injected.
	// Continuous observation joins validation: the session snapshot must be
	// fresh and anchored to THIS window, or the action refuses (fail-closed)
	// with an actionable code instead of driving from a stale reading.
	// The cheap focus probe (win) already carries the live geometry
	// (at/size) AND the exact address, so identity is proven for free on
	// every action — no extra capture. lastInputFrame is reused as the
	// pre-action frame when it belongs to the currently focused window.
	// No extra capture: the cheap focus probe (win) already reports the live
	// window rect. When it matches the anchor, noteWindowRect keeps the
	// observation's identity current for this generation — the eye stays
	// continuous while the scene holds still. Focus loss is caught by the
	// address branch inside observationInputStatus (never redirected).
	const snap0 = liveObservation.get();
	if (
		snap0 && !snap0.superseded && snap0.address === win.address &&
		snap0.frame && snap0.frame.kind === "window" &&
		snap0.frame.address === win.address && win.size[0] > 0 && win.size[1] > 0
	) {
		liveObservation.noteWindowRect(snap0.generation, { at: win.at, size: win.size });
	}
	const obsStatus = observationInputStatus({
		snapshot: liveObservation.get(),
		activeAddress: win.address,
		freshFrame: lastInputFrame && lastInputFrame.address === win.address ? lastInputFrame : null,
		activeGeometry: { at: win.at, size: win.size },
	});
	// Lazy click-target hydration (cursor fix): vision callers skip OCR on
	// screenshots for latency, so a target: click can arrive with an EMPTY
	// pool — the old refusal looped ("re-eye" → screenshot → still no words).
	// OCR the already-saved scaled frame ONCE here; later clicks hit the pool.
	// Skipped when words already exist (a miss then means the word is truly
	// absent), when the capture opted out via ocr:false, or when the
	// observation isn't fresh (validation will refuse anyway).
	if (
		isPointer && params.target && lastClickTargets.length === 0 &&
		lastFramePath && lastInputFrame && !lastCaptureOcrOptOut &&
		obsStatus.state === "fresh"
	) {
		try {
			const ocr = await ocrFrame(lastFramePath, {});
			const targets = clickTargetsFromOcr(ocr.words, lastInputFrame);
			if (targets.length > 0) rememberClickTargets(targets);
		} catch {
			// hydration is best-effort — the refusal below still lands
		}
	}
	const validation = validateInjection({
		action,
		x: params.x,
		y: params.y,
		x2: params.x2,
		y2: params.y2,
		target: params.target,
		keys: params.keys,
		modifiers: params.modifiers,
		frame: lastInputFrame,
		focusedAddress: win.address,
		observation: obsStatus,
	});
	if (!validation.ok) {
		return errText(validation.error, validation.code);
	}
	if (isPointer) {
		const frame = lastInputFrame!;
		const tx = validation.ok ? (validation.tx ?? params.x) : params.x;
		const ty = validation.ok ? (validation.ty ?? params.y) : params.y;
		const pt = frameToPhysical(frame, tx as number, ty as number);
		// Aiming happens in LOGICAL units on Wayland (hyprctl movecursor and
		// ydotool's mapped absolute moves), while frameToPhysical yields
		// PHYSICAL capture pixels — convert by the monitor scale (no-op at
		// scale 1, which is the common case).
		const scale = await detectOutputScale();
		const logical = physicalToLogical(pt.x, pt.y, scale);
		// Aim with the compositor (exact); ydotool absolute moves are unreliable on
		// Hyprland (no ABS cap on the virtual device — relative deltas + accel skew).
		// Glide, don't teleport: step the warp through eased intermediates so the
		// motion is visible in verify frames (agents can see the cursor travel
		 // instead of jumping). Short hops land in one step; long ones ease.
		const aimSteps: string[][] = [];
		if (detectPlatformDriver().id === "hyprland") {
			try {
				const from = await detectPlatformDriver().capture.cursorPos();
				if (from) {
					for (const s of liveAimGlide(from, logical)) aimSteps.push(hyprMoveCursor(s.x, s.y));
				}
			} catch {
				// cursor read failed — fall back to a single warp below
			}
			if (aimSteps.length === 0) aimSteps.push(hyprMoveCursor(logical.x, logical.y));
		}
		const aim = aimSteps.length > 0 ? aimSteps[aimSteps.length - 1] : null;
		if (action === "live_move") {
			const fail = await runSteps(
				aimSteps.length > 0 ? aimSteps : backend === "ydotool" ? [ydoMove(pt.x, pt.y)] : [xdoMove(pt.x, pt.y)],
				30,
				win.address,
			);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			// Cursor-position verify (nuphus mouse_verify pattern): read the
			// cursor back and demand ≤2px error vs the aim point (same space:
			// hyprland logical, x11 pixels). Null/throw → reads unsupported,
			// skip silently — the verify frame still covers us.
			let posNote = "";
			try {
				posNote = cursorVerifyNote(logical, await detectPlatformDriver().capture.cursorPos());
			} catch {
				// reads unsupported — verify frame still covers us
			}
			return withVerify(
				`Moved pointer to ${params.target ? `"${params.target}" ` : ""}frame (${tx},${ty}) → physical (${pt.x},${pt.y}).${posNote}`,
			);
		}
		if (action === "live_click") {
			const button = params.button ?? "left";
			const count = params.count ?? 1;
			const code = button === "right" ? YDO_RIGHT : button === "middle" ? YDO_MIDDLE : YDO_LEFT;
			const steps =
				backend === "ydotool"
					? aim
						? [...aimSteps, ydoClickButton(code, count)]
						: [ydoMove(pt.x, pt.y), ydoClickButton(code, count)]
					: [xdoClick(pt.x, pt.y, button, count)];
			const fail = await runSteps(steps, 30, win.address);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			return withVerify(
				`${count > 1 ? `${count}× ` : ""}${button} click ${params.target ? `"${params.target}" ` : ""}frame (${tx},${ty}) → physical (${pt.x},${pt.y}) on "${win.title}".`,
			);
		}
		if (action === "live_drag") {
			const before = verify ? await captureLiveFrame("Before drag") : null;
			const end = frameToPhysical(frame, params.x2!, params.y2!);
			const endLogical = physicalToLogical(end.x, end.y, scale);
			const moves: string[][] = [];
			if (backend === "ydotool") {
				// Warp to the start with the compositor (button still up), then
				// read the pointer back — the sweep must be RELATIVE from the
				// real anchor because compositor warps deliver no held-button
				// motion events, and ydotool absolute is delta+accel skewed.
				const anchor = aim
					? (await runSteps(aimSteps, 0, win.address)) === null
						? await detectPlatformDriver().capture.cursorPos()
						: null
					: null;
				if (!anchor) {
					return errText(
						"Could not anchor the drag start (aim or cursor read failed) — refusing to inject a blind sweep.",
						"drag_anchor_failed",
					);
				}
				const dx = endLogical.x - anchor.x;
				const dy = endLogical.y - anchor.y;
				const stepCount = 8;
				for (let i = 1; i <= stepCount; i++) {
					// Interpolate in logical px; emit per-step REL deltas. Steps
					// stay ≤600 because the whole drag is clamped to the screen.
					const stepDx = (dx * i) / stepCount - (dx * (i - 1)) / stepCount;
					const stepDy = (dy * i) / stepCount - (dy * (i - 1)) / stepCount;
					moves.push(ydoMoveRelative(stepDx, stepDy));
				}
			} else {
				const start = xdoMove(pt.x, pt.y);
				moves.push(xdoMove(end.x, end.y));
				const fail = await runSteps([start], 0, win.address);
				if (fail) return errObserve(action, fail);
			}
			const fail = await runDragWithCleanup(
				{ backend: backend === "ydotool" ? "ydotool" : "xdotool", shift: params.modifiers?.includes("shift") ?? false, start: [], moves },
				argv => runSteps([argv], 24, win.address),
				signal,
				runInputRelease,
			);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			let endNote = "";
			let readEnd: { x: number; y: number } | null = null;
			try {
				readEnd = await detectPlatformDriver().capture.cursorPos();
				endNote = cursorVerifyNote(endLogical, readEnd);
			} catch {
				// Endpoint reads are optional; the post-gesture verify frame remains available.
			}
			return withVerify(`Dragged frame (${params.x},${params.y}) → (${params.x2},${params.y2}).${endNote}`, {
				drag: {
					expectedEnd: endLogical,
					readEnd,
					beforeFrame: before && !("error" in before) ? before.frame : null,
					beforeCaptureError: before && "error" in before ? before.error : undefined,
				},
			});
		}
	}

	if (action === "live_type") {
		const text = params.keys ?? "";
		if (chain.length === 0) {
			return errText(
				`No typing backend available (need ydotool+daemon, wtype, or xdotool on XWayland). Probe: ydotool=${probe.ydotool}/${probe.ydotoold ? "up" : "down"}, wtype=${probe.wtype}, xdotool=${probe.xdotool}.`,
				"no_backend",
			);
		}
		const fail = await typeTextWith(chain, text, win.address);
		if (fail) return errObserve(action, fail);
		liveAuthorizedKinds.add(action);
		return withVerify(`Typed ${text.length} chars into "${win.title}"${chain[0] !== "ydotool" ? ` (backend: ${chain[0]})` : ""}.`, undefined, text);
	}

	if (action === "live_key") {
		const spec = params.keys ?? "";
		if (chain.length === 0) {
			return errText(
				`No keyboard backend available (need ydotool+daemon, wtype, or xdotool on XWayland). Probe: ydotool=${probe.ydotool}/${probe.ydotoold ? "up" : "down"}, wtype=${probe.wtype}, xdotool=${probe.xdotool}.`,
				"no_backend",
			);
		}
		const fail = await keyTextWith(chain, spec, win.address);
		if (fail) return errObserve(action, fail);
		liveAuthorizedKinds.add(action);
		return withVerify(`Sent keys "${spec}" to "${win.title}"${chain[0] !== "ydotool" ? ` (backend: ${chain[0]})` : ""}.`);
	}

	if (action === "live_scroll") {
		const dir = params.direction ?? "down";
		const before = verify ? await captureLiveFrame("Before scroll") : null;
		const x11Plan = scrollBurstPlan({ count: params.count, scrollSpeed: params.scrollSpeed, observeDuringScroll: params.observeDuringScroll });
		if (backend === "xdotool") {
			const fail = await runSteps(xdoWheelScroll(dir, x11Plan.steps), x11Plan.intervalMs, win.address);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			return withVerify(`Wheel-scrolled ${dir} ${x11Plan.steps} notch${x11Plan.steps === 1 ? "" : "es"} at ${x11Plan.speed} cadence on XWayland window "${win.title}".`, {
				scroll: { direction: dir, requestedSteps: x11Plan.steps, completedSteps: x11Plan.steps, speed: x11Plan.speed, intervalMs: x11Plan.intervalMs, samples: [], beforeFrame: before && !("error" in before) ? before.frame : null, beforeCaptureError: before && "error" in before ? before.error : undefined },
			});
		}
		if (backend === "wtype")
			return errText(
				"wtype is keyboard-only and cannot scroll. Use live_key Page_Up/Page_Down on a native window, or install a true uinput wheel backend.",
				"no_scroll",
			);
		// ydotool has no REL_WHEEL CLI path: run separate PageUp/PageDown
		// steps as a burst — one exact-address focus assertion per step, an
		// adjustable reading cadence between steps, and cheap progress
		// samples instead of a full settle after every step. This is
		// intentionally not described as a wheel notch because it scrolls
		// the focused viewport.
		const plan = scrollBurstPlan({ count: params.count, scrollSpeed: params.scrollSpeed, observeDuringScroll: params.observeDuringScroll });
		// Read during the burst instead of only after it settles. Capture/OCR is
		// intentionally best-effort: focus guarding still owns safety, while a
		// bad/blurred frame is reported as untrusted rather than used to drive.
		const scrollReadings: Array<{ words: number; chars: number; trustworthy: boolean; ocrMs: number; text: string }> = [];
		const readWhileScrolling = async (): Promise<string> => {
			const cap = await captureLiveFrame("Reading while scrolling");
			if ("error" in cap || !cap.framePath) return "read-capture-error";
			const ocr = await ocrFrame(cap.framePath);
			// ocrFrame words already carry 0..1 fractions — normalize instead of
			// scaling, so a percent-scale producer can never smuggle past (and a
			// fraction can never be divided twice into mush). Live news-site bug.
			const words = (ocr.words ?? []).map(word => ({ ...word, confidence: normalizeOcrConfidence(word.confidence) }));
			const quality = scrollFrameQuality(words);
			scrollReadings.push({
				words: words.length, chars: ocr.text.length, trustworthy: quality.trustworthy, ocrMs: ocr.ms,
				text: ocr.text.slice(0, 600),
			});
			return `read:${words.length}:${quality.trustworthy ? "trusted" : "untrusted"}`;
		};
		const burst = await runScrollBurst(ydoPageScroll(dir, plan.steps), {
			intervalMs: plan.intervalMs,
			sample: plan.sample && verify,
			expectedWindowAddress: win.address,
			signal,
			sampleFrame: plan.sample && verify ? readWhileScrolling : undefined,
		});
		if (burst.failure) return errObserve(action, burst.failure);
		liveAuthorizedKinds.add(action);
		// The reads must reach the MODEL, not just the UI: `details` is
		// metadata the agent loop never forwards, so the words go in the
		// visible text as a bounded digest while full readings stay in
		// details for the interface.
		const digest = formatScrollReadDigest(scrollReadings);
		return withVerify(
			`Scrolled ${dir} ${burst.completedSteps} page step${burst.completedSteps === 1 ? "" : "s"} at ${plan.speed} cadence (native Wayland fallback — no REL_WHEEL backend)${scrollReadings.length ? `; read ${scrollReadings.length} mid-scroll frame${scrollReadings.length === 1 ? "" : "s"}.` : ""}${digest ? `\n\nWhat was read while scrolling:\n${digest}` : ""}`,
			{
				scroll: {
					direction: dir,
					requestedSteps: plan.steps,
					completedSteps: burst.completedSteps,
					speed: plan.speed,
					intervalMs: plan.intervalMs,
					samples: burst.samples,
					readings: scrollReadings,
					beforeFrame: before && !("error" in before) ? before.frame : null,
					beforeCaptureError: before && "error" in before ? before.error : undefined,
				},
			},
		);
	}

	return errText(`Unhandled live action "${action}".`, "unhandled");
}

/** OCR one screen region at native resolution for insertion verification.
 *  A field row is a single line inside a bordered box, and `--psm 7`
 *  (single-line) mis-segments that band; block mode (`--psm 6`) reads it
 *  reliably. Two upscales are tried and the richer reading wins, since which
 *  scale resolves the glyphs depends on font size. */
async function ocrRegionNative(region: { x: number; y: number; w: number; h: number }): Promise<string | null> {
	if (region.w < 8 || region.h < 6) return null;
	const stamp = Date.now();
	const rawPath = path.join(os.tmpdir(), `aerys-insert-${stamp}-raw.png`);
	const cap = await detectPlatformDriver().capture.capture(rawPath, `${region.x},${region.y} ${region.w}x${region.h}`);
	if (cap.code !== 0) return null;
	let best = "";
	for (const scale of ["200%", "300%"]) {
		const upPath = path.join(os.tmpdir(), `aerys-insert-${stamp}-${scale.replace("%", "")}.png`);
		const conv = await runCmd("convert", [rawPath, "-resize", scale, upPath]);
		if (conv.code !== 0 || !fs.existsSync(upPath)) continue;
		const res = await runCmd("tesseract", [upPath, "stdout", "--oem", "1", "-l", "eng", "--psm", "6"], { timeout: 8000 });
		const text = res.code === 0 ? res.stdout.replace(/\s+/g, " ").trim() : "";
		if (text.replace(/\s+/g, "").length > best.replace(/\s+/g, "").length) best = text;
		fs.rm(upPath, { force: true }, () => {});
	}
	fs.rm(rawPath, { force: true }, () => {});
	return best || null;
}

/** Screen region (logical px) covering the text row where the insertion
 *  landed, clamped to the captured window so a probe can never sample a
 *  neighbouring window. */
export function insertionProbeRegion(
	frame: { atX: number; atY: number; physW: number; physH: number },
	anchorLogical: { x: number; y: number },
	pad: { left?: number; right?: number; above?: number; below?: number } = {},
): { x: number; y: number; w: number; h: number } {
	const left = pad.left ?? 420;
	const right = pad.right ?? 260;
	const above = pad.above ?? 20;
	const below = pad.below ?? 20;
	const x = Math.max(frame.atX, Math.round(anchorLogical.x - left));
	const y = Math.max(frame.atY, Math.round(anchorLogical.y - above));
	const w = Math.max(0, Math.min(Math.round(left + right), Math.round(frame.atX + frame.physW - x)));
	const h = Math.max(0, Math.min(Math.round(above + below), Math.round(frame.atY + frame.physH - y)));
	return { x, y, w, h };
}

/** Tri-state insertion verdict. `true` = confirmed present; `false` = the
 *  field row was positively read at native resolution and the text is NOT
 *  there; `null` = the row could not be localized, so the result is unknown —
 *  never report a failure that was only an unverified guess. A frame hit is
 *  positive evidence on its own (the token appeared in OCR, even if mangled). */
export function insertionVerdict(input: { nativeSeen: boolean; frameSeen: boolean; rowLocated: boolean }): boolean | null {
	if (input.nativeSeen || input.frameSeen) return true;
	return input.rowLocated ? false : null;
}

export class DesktopControlTool implements AgentTool<typeof desktopControlSchema> {
	readonly name = "desktop_control";
	readonly approval = liveApprovalDecision;
	readonly label = "Desktop Control";
	readonly description = desktopControlDescription;
	readonly parameters = desktopControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary =
		"Desktop vision + live app-control (screenshots, window mgmt, and live_* click/type/key/drag/scroll on the focused window via ydotool/wtype/xdotool; opt-in app-control mode)";

	static createIf(session: ToolSession): DesktopControlTool | null {
		return new DesktopControlTool(session);
	}

	/** Host session — optional so probes/tests can construct the tool standalone. */
	private readonly session?: ToolSession;

	constructor(session?: ToolSession) {
		this.session = session;
	}

	async execute(_id: string, params: DesktopControlParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const modifiersError = modifierRefusal(params.action, params.modifiers);
		if (modifiersError) {
			return { content: [{ type: "text", text: modifiersError }], details: { error: "invalid_modifiers" } };
		}
		switch (params.action) {
			case "live_mode_on":
			case "live_mode_off":
			case "live_mode_status":
			case "live_backend_probe":
			case "live_move":
			case "live_click":
			case "live_drag":
			case "live_type":
			case "live_key":
			case "live_scroll":
				return executeLiveAction(params.action, params, this.session, signal);
			case "list_windows": {
				const listDriver = detectPlatformDriver();
				if (listDriver.id !== "hyprland" && listDriver.id !== "x11") {
					return {
						content: [{ type: "text", text: `Window listing is not supported on this platform yet (${listDriver.label}).` }],
						details: { windows: [], driver: listDriver.id },
					};
				}
				const windows = await getDriverWindows();
				if (windows.length === 0) {
					return {
						content: [{ type: "text", text: "No open GUI windows found." }],
						details: { windows: [] },
					};
				}
				const formatted = windows
					.map(
						w =>
							`- [${w.address}] "${w.title}" (class: ${w.class}) at [${w.at[0]}, ${w.at[1]}] size [${w.size[0]}x${w.size[1]}] ws:${w.workspace}${w.focused ? " (FOCUSED)" : ""}`,
					)
					.join("\n");
				return {
					content: [{ type: "text", text: `Open Windows (${windows.length}):\n${formatted}` }],
					details: { windows },
				};
			}

			case "focus_window": {
				if (!params.query) {
					return {
						content: [
							{
								type: "text",
								text: "Error: 'query' (window title, class, or address) is required for focus_window.",
							},
						],
						details: { error: "missing_query" },
					};
				}
				const driver = detectPlatformDriver();
				if (driver.id !== "hyprland" && driver.id !== "x11") {
					return {
						content: [{ type: "text", text: `Window focus is not supported on this platform yet (${driver.label}).` }],
						details: { error: "unsupported_platform", driver: driver.id },
					};
				}
				const windows = await getDriverWindows();
				const queryLower = params.query.toLowerCase();
				const match =
					windows.find(w => w.address.toLowerCase() === queryLower) ||
					windows.find(w => w.class.toLowerCase().includes(queryLower)) ||
					windows.find(w => w.title.toLowerCase().includes(queryLower));

				if (!match) {
					return {
						content: [{ type: "text", text: `No window matching "${params.query}" found.` }],
						details: { error: "not_found", query: params.query },
					};
				}

				const fail = await driver.windows.focusWindow(match.address);
				if (fail) {
					return {
						content: [{ type: "text", text: `Failed to focus window [${match.title}]: ${fail}` }],
						details: { error: fail },
					};
				}
				// Fast-path confirm: short poll so the caller knows the focus
				// landed (5 × 120ms ≈ 0.6s max, usually the first poll).
				const confirmed = await focusWindowFast(match.address);
				if ("error" in confirmed) {
					return {
						content: [{ type: "text", text: `Focus dispatched to "${match.title}" but ${confirmed.error}` }],
						details: { error: "focus_unconfirmed", focused: match },
					};
				}
				return {
					content: [{ type: "text", text: `Focused window: "${confirmed.title}" (class: ${confirmed.class})` }],
					details: { focused: confirmed },
				};
			}

			case "close_window": {
				if (!params.query) {
					return {
						content: [
							{
								type: "text",
								text: "Error: 'query' (window title, class, or address) is required for close_window.",
							},
						],
						details: { error: "missing_query" },
					};
				}
				const closeDriver = detectPlatformDriver();
				if (closeDriver.id !== "hyprland" && closeDriver.id !== "x11") {
					return {
						content: [{ type: "text", text: `Window close is not supported on this platform yet (${closeDriver.label}).` }],
						details: { error: "unsupported_platform", driver: closeDriver.id },
					};
				}
				const windows = await getDriverWindows();
				const queryLower = params.query.toLowerCase();
				const match =
					windows.find(w => w.address.toLowerCase() === queryLower) ||
					windows.find(w => w.class.toLowerCase().includes(queryLower)) ||
					windows.find(w => w.title.toLowerCase().includes(queryLower));

				if (!match) {
					return {
						content: [{ type: "text", text: `No window matching "${params.query}" found.` }],
						details: { error: "not_found", query: params.query },
					};
				}

				const closeFail = await closeDriver.windows.closeWindow(match.address);
				if (closeFail) {
					return {
						content: [{ type: "text", text: `Failed to close window [${match.title}]: ${closeFail}` }],
						details: { error: closeFail },
					};
				}
				return {
					content: [{ type: "text", text: `Closed window: "${match.title}" (class: ${match.class})` }],
					details: { closed: match },
				};
			}

			case "switch_workspace": {
				if (!params.workspace) {
					return {
						content: [{ type: "text", text: "Error: 'workspace' is required for switch_workspace." }],
						details: { error: "missing_workspace" },
					};
				}
				const wsDriver = detectPlatformDriver();
				if (wsDriver.id !== "hyprland" && wsDriver.id !== "x11") {
					return {
						content: [{ type: "text", text: `Workspace switching is not supported on this platform yet (${wsDriver.label}).` }],
						details: { error: "unsupported_platform", driver: wsDriver.id },
					};
				}
				const wsFail = await wsDriver.windows.switchWorkspace(params.workspace);
				if (wsFail) {
					return {
						content: [{ type: "text", text: `Failed to switch workspace: ${wsFail}` }],
						details: { error: wsFail },
					};
				}
				return {
					content: [{ type: "text", text: `Switched to workspace: ${params.workspace}` }],
					details: { workspace: params.workspace, success: true },
				};
			}

			case "launch_app": {
				if (!params.command) {
					return {
						content: [{ type: "text", text: "Error: 'command' is required for launch_app." }],
						details: { error: "missing_command" },
					};
				}
				const launchDriver = detectPlatformDriver();
				if (launchDriver.id === "hyprland") {
					await launchDriver.run("hyprctl", ["dispatch", "exec", params.command]);
				} else {
					await runCmd("sh", ["-c", `${params.command} &`]);
				}
				return {
					content: [{ type: "text", text: `Launched application: ${params.command}` }],
					details: { command: params.command, success: true },
				};
			}

			// ---- headless desktop app actions (Xvfb virtual display) ----
			case "xvfb_launch": {
				if (!params.command) {
					return {
						content: [{ type: "text", text: "Error: 'command' is required for xvfb_launch." }],
						details: { error: "missing_command" },
					};
				}
				try {
					await xvfbEnsureServer();
					let cmd = xvfbCommandFixup(params.command);
					if (params.url) cmd += ` ${params.url}`;
					// detached so the app outlives this call
					await runCmd("sh", ["-c", `nohup ${cmd} >/tmp/aerys-xvfb-app.log 2>&1 &`], {
						env: xvfbEnv(),
						timeout: 12_000,
					});
					// Poll for the window to map instead of sleeping a fixed 4s.
					// Also diff against the pre-launch window set: with another
					// app already on screen, "any window mapped" returns
					// instantly and this launch's own window is never named.
					const t0 = Date.now();
					const before = await xvfbListWindows();
					const after_ = await xvfbPollForWindows();
					const fresh = xvfbNewWindows(before, after_);
					const note = fresh.length
						? ` New windows from this launch: ${fresh.join(" | ")}.`
						: after_.length
							? " No new window named this launch (may still be loading) — verify with xvfb_screenshot."
							: " No window mapped yet (may still be loading) — check with xvfb_list_windows or xvfb_screenshot.";
					return {
						content: [
							{
								type: "text",
								text: `Launched '${params.command}' invisibly on the virtual display.${note}`,
							},
						],
						details: {
							command: params.command,
							headless: true,
							windows: after_,
							newWindows: fresh,
							waitMs: Date.now() - t0,
						},
					};
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `xvfb_launch failed: ${String(err)}. Is xorg-server-xvfb installed?` },
						],
						details: { error: "xvfb_launch_failed" },
					};
				}
			}

			case "xvfb_screenshot": {
				try {
					await xvfbEnsureServer();
					const outPath = `/tmp/aerys-xvfb-shot-${Date.now()}.png`;
					const shot = await runCmd("import", ["-window", "root", outPath], { env: xvfbEnv(), timeout: 15_000 });
					if (shot.code !== 0 || !fs.existsSync(outPath)) {
						return { content: [{ type: "text", text: `xvfb_screenshot failed: ${shot.stderr}` }] };
					}
					const [physW, physH] = xvfbGeometry();
					const wantOcr = params.ocr ?? true;
					let eye = await headlessEyeRead({
						rawPath: outPath,
						physW,
						physH,
						maxWidth: params.maxWidth,
						maxHeight: params.maxHeight,
						ocr: wantOcr,
					});
					// Bare Xvfb has no compositor: ARGB/GL windows map but never
					// paint into the root capture, so a blank root with visible
					// windows means "uncomposited", not "empty". Re-read from a
					// white-flattened stack of the windows at their absolute
					// positions — coordinates stay fullscreen-origin.
					let composited = false;
					if (wantOcr && eye.emptyRoot) {
						const mapped = await xvfbMappedWindows();
						if (mapped.length > 0) {
							const stack = await xvfbCompositeWindows(outPath, mapped);
							if (stack) {
								eye = await headlessEyeRead({
									rawPath: stack,
									physW,
									physH,
									maxWidth: params.maxWidth,
									maxHeight: params.maxHeight,
									ocr: wantOcr,
								});
								composited = !eye.emptyRoot;
							}
						}
					}
					// Bind frame and targets to ONE generation. A later reading
					// with a different frame (a maxWidth cap, a composite rescue,
					// an ocr:false pass) must not be able to reuse these boxes:
					// mapping stale boxes through a new frame silently clicks
					// somewhere else (B2 landed at display 188,218 instead of
					// 375,435). An ocr:false pass records NO targets, so word
					// clicks refuse until a real reading happens again.
					xvfbFrame = eye.frame;
					xvfbGeneration = ++xvfbGeneration;
					if (wantOcr) rememberXvfbTargets(eye.targets);
					else rememberXvfbTargets([]);
					const buf = fs.readFileSync(eye.scaledPath);
					const size = buf.length;
					const lines = [`Captured the headless virtual display (${XVFB_GEOMETRY}) → ${eye.scaledPath}${composited ? " (window-composited: no compositor on bare Xvfb, so mapped windows were stacked at their positions)." : ""}.`];
					if (wantOcr && eye.text) {
						lines.push(
							`On-screen text (${eye.text.length} chars, tesseract ${eye.ocrMode ?? "native"}):`,
							eye.text.length > 8000 ? `${eye.text.slice(0, 8000)}\n…[truncated]` : eye.text,
						);
						const ct = formatClickTargets(eye.targets);
						if (ct) lines.push(ct.replace("live_click", "xvfb_click"));
					} else if (wantOcr && eye.ocrError) {
						lines.push(`OCR failed: ${eye.ocrError}`);
					} else if (wantOcr && eye.emptyRoot) {
						lines.push("Note: capture looks empty (no windows on the virtual display?).");
					} else if (!wantOcr) {
						lines.push("OCR skipped (ocr:false).");
					}
					// Auth trigger: a credential prompt on screen means the next
					// step is the USER's to do. Tell the agent to offer the
					// projection rather than guessing or asking for the secret.
					const authHint = wantOcr ? xvfbAuthPromptHint(eye.text) : null;
					if (authHint) {
						lines.push(
							`Auth needed (${authHint}): this step is the user's to do. Offer to project the session — xvfb_project {} — so they can type it themselves. Never ask them to tell you the secret; verify success from the app's own state afterwards.`,
						);
					}
					return {
						content: [
							{ type: "text", text: lines.join("\n") },
							...(size > 500 && !(params.textOnly ?? false) && (params.includeBase64 ?? true)
								? [{ type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" }]
								: []),
						],
						details: {
							file: eye.scaledPath,
							rawFile: outPath,
							bytes: size,
							headless: true,
							frame: eye.frame,
							emptyRoot: eye.emptyRoot,
							...(wantOcr
								? {
										ocrText: eye.text,
										ocrMs: eye.ocrMs,
										...(eye.ocrMode ? { ocrMode: eye.ocrMode } : {}),
										...(eye.ocrError ? { ocrError: eye.ocrError } : {}),
									}
								: {}),
							...(eye.targets.length > 0 ? { clickTargets: eye.targets } : {}),
							...(authHint ? { authPrompt: authHint } : {}),
						},
					};
				} catch (err) {
					return { content: [{ type: "text", text: `xvfb_screenshot failed: ${String(err)}` }] };
				}
			}

			case "xvfb_list_windows": {
				await xvfbEnsureServer();
				const windows = await xvfbListWindows();
				return {
					content: [
						{
							type: "text",
							text: windows.length
								? `Windows on the headless virtual display:\n${windows.map(w => `- ${w}`).join("\n")}`
								: "No windows on the headless virtual display. Launch one with 'xvfb_launch'.",
						},
					],
					details: { windows, headless: true },
				};
			}

			case "xvfb_click": {
				// Word-anchored click wins: a target resolves against the LAST
				// xvfb eye reading (fail-closed on unknown words). Raw x/y is the
				// fallback and is mapped from the scaled eye frame to raw display.
				await xvfbEnsureServer();
				let sx: number | undefined = params.x;
				let sy: number | undefined = params.y;
				let anchor = "";
				if (params.target) {
					// A word target is only meaningful in the frame of the reading
					// that produced it. If the last screenshot changed the frame
					// (or skipped OCR entirely), refuse instead of mapping an old
					// box through a new frame.
					if (!xvfbTargetsAreCurrent()) {
						return {
							content: [
								{
									type: "text",
									text: `Error: no current word targets — the last reading did not produce any (ocr:false or an empty capture). Take xvfb_screenshot again before clicking '${params.target}'.`,
								},
							],
							details: { error: "stale_targets", target: params.target },
						};
					}
					const hit = resolveXvfbTarget(params.target);
					if (!hit) {
						return {
							content: [
								{
									type: "text",
									text: `Error: '${params.target}' was not found in the last xvfb eye reading — take xvfb_screenshot first (no blind click).`,
								},
							],
							details: { error: "unknown_target", target: params.target },
						};
					}
					sx = hit.x;
					sy = hit.y;
					anchor = `"${hit.box.text}" `;
				}
				if (sx === undefined || sy === undefined) {
					return {
						content: [
							{
								type: "text",
								text: "Error: pass 'target' (a word from the last xvfb_screenshot) or 'x' and 'y' pixel coordinates for xvfb_click.",
							},
						],
						details: { error: "missing_coordinates" },
					};
				}
				const [dx, dy] = xvfbFrameToDisplay(sx, sy, xvfbFrame);
				const [physW, physH] = xvfbGeometry();
				if (dx < 0 || dy < 0 || dx >= physW || dy >= physH) {
					return {
						content: [
							{
								type: "text",
								text: `Error: mapped click (${dx},${dy}) is outside the virtual display ${physW}x${physH} — refusing out-of-bounds injection.`,
							},
						],
						details: { error: "out_of_bounds", mapped: [dx, dy] },
					};
				}
				// XTEST buttons are numeric: named buttons fail with BadValue.
				const btnName = params.button ?? "left";
				const btn = btnName === "right" ? "3" : btnName === "middle" ? "2" : "1";
				// Human-like approach: curve and ease from wherever the pointer is
				// to the target, settle, then press/hold/release — instead of a
				// teleport-and-fire. A missing origin read still yields a real
				// (uncurved) path from the target itself, never a blind jump.
				const origin = await xvfbPointerPosition();
				const path = clickPath(origin?.x ?? dx, origin?.y ?? dy, dx, dy, DEFAULT_MOTION_CONFIG);
				const injected = await xvfbInjectPath(path.steps, {
					press: btn,
					release: btn,
					settleMs: CLICK_CHOREOGRAPHY.settleMs,
					holdMs: CLICK_CHOREOGRAPHY.holdMs,
				});
				if (injected.code !== 0) {
					return { content: [{ type: "text", text: `xvfb_click failed: ${injected.stderr}` }] };
				}
				const motionNote =
					path.steps.length > 1
						? ` (${path.steps.length}-step eased approach, ${path.totalMs}ms)`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Clicked ${btnName} ${anchor}at display ${dx},${dy} (frame ${sx},${sy}) on the headless display${motionNote}.`,
						},
					],
					details: {
						button: btnName,
						frame: [sx, sy],
						display: [dx, dy],
						headless: true,
						motion: { steps: path.steps.length, totalMs: path.totalMs, origin },
					},
				};
			}

			case "xvfb_drag": {
				// Word-anchored drag wins for the start, target2 for the end; raw
				// x/y/x2/y2 is the fallback. Anchors resolve against the LAST
				// xvfb eye reading (fail-closed, same as xvfb_click).
				await xvfbEnsureServer();
				let sx: number | undefined = params.x;
				let sy: number | undefined = params.y;
				let ex: number | undefined = params.x2;
				let ey: number | undefined = params.y2;
				let startAnchor = "";
				let endAnchor = "";
				if (!xvfbTargetsAreCurrent() && (params.target || params.target2)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: no current word targets — the last reading did not produce any (ocr:false or an empty capture). Take xvfb_screenshot again before dragging '${params.target ?? ""}'→'${params.target2 ?? ""}'.`,
							},
						],
						details: { error: "stale_targets", target: params.target, target2: params.target2 },
					};
				}
				if (params.target) {
					const hit = resolveXvfbTarget(params.target);
					if (!hit) {
						return {
							content: [
								{
									type: "text",
									text: `Error: '${params.target}' was not found in the last xvfb eye reading — take xvfb_screenshot first (no blind drag).`,
								},
							],
							details: { error: "unknown_target", target: params.target },
						};
					}
					sx = hit.x;
					sy = hit.y;
					startAnchor = `"${hit.box.text}" `;
				}
				if (params.target2) {
					const hit = resolveXvfbTarget(params.target2);
					if (!hit) {
						return {
							content: [
								{
									type: "text",
									text: `Error: '${params.target2}' was not found in the last xvfb eye reading — take xvfb_screenshot first (no blind drag).`,
								},
							],
							details: { error: "unknown_target", target2: params.target2 },
						};
					}
					ex = hit.x;
					ey = hit.y;
					endAnchor = `"${hit.box.text}" `;
				}
				if (sx === undefined || sy === undefined) {
					return {
						content: [
							{
								type: "text",
								text: "Error: pass 'target' (a word from the last xvfb_screenshot) or 'x' and 'y' pixel coordinates for the xvfb_drag start point.",
							},
						],
						details: { error: "missing_coordinates" },
					};
				}
				if (ex === undefined || ey === undefined) {
					return {
						content: [
							{
								type: "text",
								text: "Error: pass 'target2' (a word from the last xvfb_screenshot) or 'x2' and 'y2' pixel coordinates for the xvfb_drag end point.",
							},
						],
						details: { error: "missing_xy2" },
					};
				}
				const [sdx, sdy] = xvfbFrameToDisplay(sx, sy, xvfbFrame);
				const [edx, edy] = xvfbFrameToDisplay(ex, ey, xvfbFrame);
				const [physW, physH] = xvfbGeometry();
				const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < physW && y < physH;
				if (!inside(sdx, sdy) || !inside(edx, edy)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: mapped drag (${sdx},${sdy})→(${edx},${edy}) is outside the virtual display ${physW}x${physH} — refusing out-of-bounds injection.`,
							},
						],
						details: { error: "out_of_bounds", start: [sdx, sdy], end: [edx, edy] },
					};
				}
				// Human-like drag: eased approach from the current pointer to the
				// press point, settle, press+hold, then the held sweep itself at
				// full (steady) pacing — never a yank. A missing origin read still
				// yields a real path from the start anchor, never a blind jump.
				// XTEST buttons are numeric: named buttons fail with BadValue.
				const dragBtnName = params.button ?? "left";
				const dragBtn = dragBtnName === "right" ? "3" : dragBtnName === "middle" ? "2" : "1";
				const origin = await xvfbPointerPosition();
				const approach = clickPath(origin?.x ?? sdx, origin?.y ?? sdy, sdx, sdy, DEFAULT_MOTION_CONFIG);
				const sweep = dragPath(sdx, sdy, edx, edy, DEFAULT_MOTION_CONFIG);
				const injected = await xvfbInjectDrag(approach.steps, sweep.steps, {
					button: dragBtn,
					settleMs: DRAG_CHOREOGRAPHY.settleMs,
					pressHoldMs: DRAG_CHOREOGRAPHY.pressHoldMs,
					endHoldMs: DRAG_CHOREOGRAPHY.endHoldMs,
					afterMs: DRAG_CHOREOGRAPHY.afterMs,
				});
				if (injected.code !== 0) {
					return { content: [{ type: "text", text: `xvfb_drag failed: ${injected.stderr}` }] };
				}
				return {
					content: [
						{
							type: "text",
							text: `Dragged ${startAnchor}frame (${sx},${sy}) → ${endAnchor}frame (${ex},${ey}) on the headless display (${approach.steps.length}+${sweep.steps.length}-step eased sweep, ${approach.totalMs + sweep.totalMs}ms).`,
						},
					],
					details: {
						button: dragBtnName,
						start: { frame: [sx, sy], display: [sdx, sdy] },
						end: { frame: [ex, ey], display: [edx, edy] },
						headless: true,
						motion: {
							approachSteps: approach.steps.length,
							sweepSteps: sweep.steps.length,
							totalMs: approach.totalMs + sweep.totalMs,
							origin,
						},
					},
				};
			}

			case "xvfb_type": {
				if (!params.keys) {
					return {
						content: [{ type: "text", text: "Error: 'keys' (the text to type) is required for xvfb_type." }],
					};
				}
				await xvfbEnsureServer();
				const kb = await xvfbKeyboardTarget();
				if (!kb) {
					return {
						content: [
							{
								type: "text",
								text: "Error: no window to type into — the virtual display has no focusable app window. Launch one with xvfb_launch (or take xvfb_screenshot to see what is on screen).",
							},
						],
						details: { error: "no_keyboard_target" },
					};
				}
				const res = await runCmd("xdotool", buildXvfbTypeArgs(params.keys, kb.id), { env: xvfbEnv() });
				return res.code === 0
					? {
							content: [
								{
									type: "text",
									text: `Typed text into the headless window ${kb.id}${kb.viaActiveWindow ? " (active window)" : " (focused for input; no window manager on this display)"}.`,
								},
							],
							details: { window: kb.id, viaActiveWindow: kb.viaActiveWindow, headless: true },
						}
					: { content: [{ type: "text", text: `xvfb_type failed: ${res.stderr}` }] };
			}

			case "xvfb_key": {
				if (!params.keys) {
					return {
						content: [
							{
								type: "text",
								text: "Error: 'keys' (key names like Return, Tab, ctrl+l) is required for xvfb_key.",
							},
						],
					};
				}
				await xvfbEnsureServer();
				const kb = await xvfbKeyboardTarget();
				if (!kb) {
					return {
						content: [
							{
								type: "text",
								text: "Error: no window to send keys to — the virtual display has no focusable app window. Launch one with xvfb_launch (or take xvfb_screenshot to see what is on screen).",
							},
						],
						details: { error: "no_keyboard_target" },
					};
				}
				const res = await runCmd("xdotool", buildXvfbKeyArgs(params.keys, kb.id), { env: xvfbEnv() });
				return res.code === 0
					? {
							content: [
								{
									type: "text",
									text: `Sent keys '${params.keys}' to the headless window ${kb.id}${kb.viaActiveWindow ? " (active window)" : " (focused for input; no window manager on this display)"}.`,
								},
							],
							details: { window: kb.id, viaActiveWindow: kb.viaActiveWindow, keys: params.keys, headless: true },
						}
					: { content: [{ type: "text", text: `xvfb_key failed: ${res.stderr}` }] };
			}

			case "xvfb_project": {
				const mode = params.mode ?? "start";
				if (mode === "status") {
					const stat = await xvfbMirrorStat();
					const alive = xvfbMirrorAlive();
					return {
						content: [{ type: "text", text: alive ? `Projection live (${stat}).` : "No projection running." }],
						details: { running: alive, stat, headless: true },
					};
				}
				if (mode === "stop") {
					const wasAlive = xvfbMirrorAlive();
					await xvfbMirrorStop();
					return {
						content: [{ type: "text", text: wasAlive ? "Projection stopped." : "No projection was running." }],
						details: { wasRunning: wasAlive, headless: true },
					};
				}
				// ---- start ----
				await xvfbEnsureServer();
				if (xvfbMirrorAlive()) {
					return {
						content: [{ type: "text", text: "A projection is already live. Stop it first (mode 'stop') or check status." }],
						details: { error: "already_running", headless: true },
					};
				}
				// Resolve the target: a specific window by name, or the whole
				// workspace when no target given.
				let windowId = "";
				if (params.target) {
					const wanted = params.target.toLowerCase();
					const wins = await xvfbListWindows();
					const match = wins.find(w => w.toLowerCase().includes(wanted));
					if (!match) {
						return {
							content: [{ type: "text", text: `No headless window matches '${params.target}'. Visible windows: ${wins.join(" | ") || "none"}.` }],
							details: { error: "unknown_target", headless: true },
						};
					}
					const idRes = await runCmd("xdotool", ["search", "--name", match], { env: xvfbEnv() });
					windowId = idRes.stdout.split("\n").pop() ?? "";
				}
				const script = xvfbMirrorScript();
				if (!fs.existsSync(script)) {
					return {
						content: [{ type: "text", text: `xvfb-mirror.py not found at ${script}.` }],
						details: { error: "mirror_missing", headless: true },
					};
				}
				const logPath = `/tmp/aerys-xvfb-mirror-${Date.now()}.log`;
				const out = fs.openSync(logPath, "a");
				const child = spawn("python3", [
					script,
					"--target", XVFB_DISPLAY,
					...(windowId ? ["--window", windowId] : []),
					"--width", "960",
					"--fps", "12",
					"--title", XVFB_MIRROR_TITLE,
				], { detached: true, stdio: ["ignore", out, out] });
				child.unref();
				// Gate on the painted frame signal (FRAME1), never a fixed sleep.
				const deadline = Date.now() + 15000;
				let ready = false;
				for (;;) {
					if (child.pid === undefined) break;
					try {
						process.kill(child.pid, 0);
					} catch {
						break;
					}
					try {
						if (fs.readFileSync(logPath, "utf-8").includes("FRAME1")) {
							ready = true;
							break;
						}
					} catch {
						/* log not yet written */
					}
					if (Date.now() >= deadline) break;
					await new Promise(r => setTimeout(r, 200));
				}
				if (!ready) {
					await xvfbMirrorStop();
					return {
						content: [{ type: "text", text: "Projection failed to start (mirror never painted a frame). Check the log." }],
						details: { error: "mirror_timeout", log: logPath, headless: true },
					};
				}
				xvfbMirrorProc = { pid: child.pid ?? 0, log: logPath };
				return {
					content: [
						{
							type: "text",
							text: `Projection live: the user can see the headless session in real time (window titled '${XVFB_MIRROR_TITLE}') and type into it. Never read or log anything the user types there — verify outcomes from the app's own state instead.`,
						},
					],
					details: { pid: child.pid, log: logPath, window: windowId || "workspace", headless: true },
				};
			}

			case "xvfb_close": {
				// Close all windows, kill the server, then WAIT for it to be
				// actually gone. Returning while Xvfb is still dying races the
				// next xvfbEnsureServer probe: a half-dead display answers just
				// long enough to look alive, and the restart never happens.
				await xvfbMirrorStop();
				const wins = await xvfbListWindows();
				const env = xvfbEnv();
				for (const w of wins) {
					await runCmd("xdotool", ["search", "--name", w, "windowclose"], { env });
				}
				await runCmd("sh", ["-c", `pkill -f "DISPLAY=${XVFB_DISPLAY}" 2>/dev/null; true`]);
				await runCmd("pkill", ["Xvfb"]).catch?.(() => {});
				xvfbServerAlive = false;
				xvfbFrame = null;
				++xvfbGeneration;
				rememberXvfbTargets([]);
				const goneDeadline = Date.now() + 5000;
				for (;;) {
					const probe = await runCmd("sh", ["-c", `DISPLAY=${XVFB_DISPLAY} xdotool getdisplaygeometry`]);
					if (probe.code !== 0) break;
					if (Date.now() >= goneDeadline) break;
					await new Promise(r => setTimeout(r, 150));
				}
				return {
					content: [
						{
							type: "text",
							text: `Headless session closed (${wins.length} window(s) closed, virtual display stopped).`,
						},
					],
					details: { closed: wins.length, headless: true },
				};
			}

			case "system_control": {
				const sub = params.subAction;
				if (!sub) {
					return {
						content: [{ type: "text", text: "Error: 'subAction' is required for system_control." }],
						details: { error: "missing_sub_action" },
					};
				}

				switch (sub) {
					case "volume_up": {
						await runCmd("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"]);
						return {
							content: [{ type: "text", text: "Volume increased by 5%, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "volume_down": {
						await runCmd("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"]);
						return {
							content: [{ type: "text", text: "Volume decreased by 5%, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "set_volume": {
						const val = Math.max(0, Math.min(100, Math.round(params.value ?? 50)));
						const frac = (val / 100).toFixed(2);
						await runCmd("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", frac]);
						return {
							content: [{ type: "text", text: `Volume set to ${val} percent, Peter.` }],
							details: { action: sub, value: val, success: true },
						};
					}
					case "mute":
					case "unmute": {
						await runCmd("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]);
						return {
							content: [{ type: "text", text: "Audio mute toggled, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "play_pause": {
						await runCmd("playerctl", ["play-pause"]);
						return {
							content: [{ type: "text", text: "Media playback toggled, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "next_track": {
						await runCmd("playerctl", ["next"]);
						return {
							content: [{ type: "text", text: "Playing next track, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "prev_track": {
						await runCmd("playerctl", ["previous"]);
						return {
							content: [{ type: "text", text: "Playing previous track, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "set_brightness": {
						const val = Math.max(5, Math.min(100, Math.round(params.value ?? 50)));
						await runCmd("brightnessctl", ["set", `${val}%`]);
						return {
							content: [{ type: "text", text: `Screen brightness set to ${val} percent, Peter.` }],
							details: { action: sub, value: val, success: true },
						};
					}
					case "lock_screen": {
						await runCmd("hyprctl", ["dispatch", "exec", "hyprlock"]);
						return {
							content: [{ type: "text", text: "Screen locked, Peter." }],
							details: { action: sub, success: true },
						};
					}
					case "web_search": {
						const q = (params.query || "").trim();
						if (!q) {
							return {
								content: [{ type: "text", text: "Error: 'query' is required for web_search." }],
								details: { error: "missing_query" },
							};
						}
						const platform = params.platform || "google";
						const urls: Record<string, string> = {
							youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
							github: `https://github.com/search?q=${encodeURIComponent(q)}`,
							reddit: `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
							stackoverflow: `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
							wikipedia: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
							google: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
						};
						const targetUrl = urls[platform] || urls.google;
						await runCmd("xdg-open", [targetUrl]);
						return {
							content: [{ type: "text", text: `Searching ${platform} for "${q}" in your browser, Peter.` }],
							details: { action: sub, platform, query: q, url: targetUrl, success: true },
						};
					}
				}
				return {
					content: [{ type: "text", text: "Unhandled system_control sub-action." }],
					details: { error: "unhandled_sub_action" },
				};
			}

			case "cursor_pos": {
				const pos = await detectPlatformDriver().capture.cursorPos().catch(() => null);
				if (pos) {
					return {
						content: [{ type: "text", text: `Cursor position: X=${pos.x}, Y=${pos.y}` }],
						details: pos,
					};
				}
				return {
					content: [{ type: "text", text: "Could not retrieve cursor position." }],
					details: { error: "unsupported" },
				};
			}

			case "screenshot": {
				// A deliberate re-look is the drive loop's recovery path ("re-eye
				// and re-plan"): clear the counters so the model can act on what
				// it sees instead of staying locked out.
				resetDriveLoop();
				const target = params.target ?? "active_window";
				const timestamp = Date.now();
				const tmpRaw = path.join(os.tmpdir(), `aerys-shot-${timestamp}-raw.png`);
				const tmpScaled = path.join(os.tmpdir(), `aerys-shot-${timestamp}.png`);

				let geometry: string | undefined;
				let targetWindow: DesktopWindowInfo | undefined;

				if (isSupportedDriver()) {
					if (target === "active_window") {
						targetWindow = await getDriverActiveWindow();
						if (targetWindow && targetWindow.size[0] > 0 && targetWindow.size[1] > 0) {
							geometry = `${targetWindow.at[0]},${targetWindow.at[1]} ${targetWindow.size[0]}x${targetWindow.size[1]}`;
						}
					} else if (target !== "fullscreen") {
						const windows = await getDriverWindows();
						const q = target.toLowerCase();
						targetWindow =
							windows.find(w => w.address.toLowerCase() === q) ||
							windows.find(w => w.class.toLowerCase().includes(q)) ||
							windows.find(w => w.title.toLowerCase().includes(q));
						if (targetWindow && targetWindow.size[0] > 0 && targetWindow.size[1] > 0) {
							geometry = `${targetWindow.at[0]},${targetWindow.at[1]} ${targetWindow.size[0]}x${targetWindow.size[1]}`;
						}
					}
				}
				// Capture via the platform driver (grim on Hyprland, import/scrot on X11).
				const shotDriver = detectPlatformDriver();
				const capRes = await shotDriver.capture.capture(tmpRaw, geometry).catch((e: unknown) => ({ code: 1, stderr: String(e) }));
				if (capRes.code !== 0) {
					return {
						content: [{ type: "text", text: `Failed to capture screenshot (${shotDriver.id}): ${capRes.stderr}` }],
						details: { error: capRes.stderr, driver: shotDriver.id },
					};
				}

				// Downscale for vision model using ImageMagick convert if available
				const maxWidth = params.maxWidth ?? 1280;
				const maxHeight = params.maxHeight ?? 800;

				let finalPath = tmpRaw;
				const resizeRes = await runCmd("convert", [tmpRaw, "-resize", `${maxWidth}x${maxHeight}>`, tmpScaled]);
				if (resizeRes.code === 0 && fs.existsSync(tmpScaled)) {
					finalPath = tmpScaled;
				}

				// Record the model-visible coordinate frame for live_* mapping (D002/D004).
				let frameSize: { width: number; height: number } | undefined;
				let frameNote = "";
				let remembered: InputFrame | null = null;
				if (isSupportedDriver()) {
					try {
						remembered = await rememberFrame(targetWindow, geometry, tmpRaw, finalPath);
						if (remembered) {
							frameSize = { width: remembered.scaledW, height: remembered.scaledH };
							frameNote = ` Frame ${remembered.scaledW}x${remembered.scaledH}${remembered.kind === "window" ? ` (window @ ${remembered.atX},${remembered.atY})` : " (fullscreen)"} — live_* pointer coordinates are frame px of this image.`;
						}
					} catch {}
				}

				const includeBase64 = params.includeBase64 ?? true;
				let base64 = "";
				if (includeBase64) {
					try {
						const buf = await fs.promises.readFile(finalPath);
						base64 = buf.toString("base64");
					} catch {}
				}
				// OCR layer (mirrors live_eye): automatic for a visionless model so
				// a captured screenshot reads as text instead of dead pixels;
				// opt-out via ocr:false. Vision-capable callers keep the
				// pixel-first FAST result (a tesseract pass costs 4-5s here);
				// their click targets hydrate LAZILY on the first target: click
				// (executeLiveAction OCRs lastFramePath once) instead of making
				// every screenshot pay OCR. Visionless callers OCR as before.
				const shotModelSeesImages = this.session?.supportsVision?.() ?? true;
				const shotWantOcr = params.ocr ?? !shotModelSeesImages;
				// Explicit ocr:false = "words deliberately unread" → block lazy
				// target hydration for this capture (the documented contract:
				// ocr:false clears targets, a click then refuses).
				lastCaptureOcrOptOut = params.ocr === false;
				let shotOcrText = "";
				let shotOcrError: string | undefined;
				let shotOcrMode: "native" | "upscaled" | undefined;
				let shotOcrMs0 = 0;
				let shotClickTargets: ClickTarget[] = [];
				if (shotWantOcr) {
					shotOcrMs0 = Date.now();
					const shotOcr = await ocrFrame(finalPath, { lang: params.ocrLang });
					shotOcrText = shotOcr.text;
					shotOcrError = shotOcr.error;
					shotOcrMode = shotOcr.mode;
					// Durable copy: screenshot tool results are prunable, so the
					// full reading also lands in the watch transcript (the book).
					if (shotOcrText) CameraWatchLoop.recordExternalOcr(shotOcrText, "screenshot");
					if (shotOcrText) rememberOcrText(shotOcrText);
					// Clickable-OCR: word boxes → frame-px click targets the model
					// can pass to live_move/live_click (or target: "Compose").
					shotClickTargets = clickTargetsFromOcr(shotOcr.words, remembered);
					if (shotClickTargets.length > 0) rememberClickTargets(shotClickTargets);
				}
				const shotTargetDesc = targetWindow
					? `window "${targetWindow.title}" (${targetWindow.class}) [${targetWindow.size[0]}x${targetWindow.size[1]}]`
					: geometry
						? `geometry ${geometry}`
						: "fullscreen display";
				const shotTextParts = [
					`Captured screenshot of ${shotTargetDesc} (saved to ${finalPath}).${frameNote}`,
				];
				if (shotOcrText) {
					shotTextParts.push(
						`On-screen text (${shotOcrText.length} chars, tesseract ${shotOcrMode ?? "native"}):`,
						shotOcrText.length > 8000 ? `${shotOcrText.slice(0, 8000)}\n…[truncated]` : shotOcrText,
					);
				}
				if (shotOcrText || shotClickTargets.length > 0) {
					const ct = formatClickTargets(shotClickTargets);
					if (ct) shotTextParts.push(ct);
				} else if (shotWantOcr && shotOcrError) {
					shotTextParts.push(`OCR failed: ${shotOcrError}`);
				} else if (shotWantOcr) {
					shotTextParts.push("OCR produced no text (frame may contain no readable text).");
				}
				// Screenshot keeps its pixels: the user asked to SEE the frame, so
				// the image block always rides along (OCR text sits beside it for
				// visionless readers). Only the eye's ambient glances go text-only.
				const shotTextOnly = false;

				const details: ScreenshotResultDetails = {
					filePath: finalPath,
					physicalDimensions: targetWindow
						? { width: targetWindow.size[0], height: targetWindow.size[1] }
						: { width: 1920, height: 1080 },
					...(frameSize ? { scaledDimensions: frameSize } : {}),
					target,
					targetWindow: targetWindow
						? { title: targetWindow.title, class: targetWindow.class, address: targetWindow.address }
						: undefined,
					...anchorLiveObservation([{ frame: remembered, text: shotOcrText || undefined, windowRect: targetWindow && targetWindow.size[0] > 0 && targetWindow.size[1] > 0 ? { at: targetWindow.at, size: targetWindow.size } : undefined }]),
					...(shotWantOcr
						? {
								ocrText: shotOcrText,
								ocrMode: shotOcrMode,
								ocrMs: Date.now() - shotOcrMs0,
								...(shotOcrError ? { ocrError: shotOcrError } : {}),
							}
						: {}),
					...(shotClickTargets.length > 0 ? { clickTargets: shotClickTargets } : {}),
				};

				return {
					content: [
						{
							type: "text",
							text: shotTextParts.join("\n"),
						},
						...(shotTextOnly
							? []
							: base64
								? [
										{
											type: "image" as const,
											data: base64,
											mimeType: "image/png",
										},
									]
								: []),
					],
					details: details as unknown as Record<string, unknown>,
				};
			}

			case "live_eye": {
				// Fast glance. Ephemeral by design: each eye view is marked
				// details.liveEye so the session can sweep old eye images from
				// context at the next user prompt (steady state: ~1 eye image).
				// A glance is also a re-plan, which is the drive loop's recovery
				// path ("re-eye and re-plan") — clear the counters so the model
				// can act on what it sees instead of staying locked out.
				resetDriveLoop();
			const includeBase64 = params.includeBase64 ?? true;
			const textOnly = params.textOnly ?? false;
			const timestamp = Date.now();
			const maxWidth = params.maxWidth ?? 1280;
			const maxHeight = params.maxHeight ?? 800;

			// ---- Resolve the view list (multi-focus vs single-glance) ----
			// views[] is the human-eye path: 1-4 focus points in one glance
			// (wide context + a fovea crop, or several windows). No views[]
			// means the classic single view built from top-level params —
			// byte-for-byte the old behavior.
			interface EyeViewSpec {
				label: string;
				target?: string;
				region?: EyeRegion;
			}
			const viewSpecs: EyeViewSpec[] = params.views?.length
				? params.views.map((v, i) => ({
						label: v.label || `view ${i + 1}`,
						target: v.target,
						region: v.region,
					}))
				: [{ label: "", target: params.target, region: params.region }];

			// Ephemeral sweep: drop previous eye images from history BEFORE capturing
			// the new ones (best-effort; tolerated if the host lacks the hook).
			let swept = 0;
			try {
				swept = (await this.session?.dropLiveEyeImages?.()) ?? 0;
			} catch {}

			const eyeDriver = detectPlatformDriver();
			if (!isSupportedDriver() && viewSpecs.length > 1) {
				return {
					content: [{ type: "text", text: `Multi-view eye is not supported on this platform yet (${eyeDriver.label}).` }],
					details: { error: "unsupported_platform", driver: eyeDriver.id },
				};
			}

			// ---- Resolve each view's geometry/window concurrently ----
			const resolved = await Promise.all(
				viewSpecs.map(async (spec): Promise<EyeViewSpec & { geometry?: string; window?: DesktopWindowInfo; desc: string }> => {
					if (spec.region) {
						const geometry = buildEyeGeometry(spec.region, undefined);
						return { ...spec, geometry, desc: `region ${geometry}` };
					}
					const target = spec.target ?? "fullscreen";
					let window: DesktopWindowInfo | undefined;
					let geometry: string | undefined;
					if (isSupportedDriver()) {
						if (target === "active_window") {
							window = await getDriverActiveWindow();
						} else if (target !== "fullscreen") {
							const windows = await getDriverWindows();
							const q = target.toLowerCase();
							window =
								windows.find(w => w.address.toLowerCase() === q) ||
								windows.find(w => w.class.toLowerCase().includes(q)) ||
								windows.find(w => w.title.toLowerCase().includes(q));
						}
						geometry = buildEyeGeometry(undefined, window);
					}
					return { ...spec, geometry, window, desc: describeEyeTarget(window, geometry, target) };
				}),
			);

			// ---- Capture all views concurrently (the eye saccades in parallel) ----
			const captures = await Promise.all(
				resolved.map(async (v, i) => {
					const rawPath = path.join(os.tmpdir(), `aerys-eye-${timestamp}-${i}-raw.png`);
					const finalPath = path.join(os.tmpdir(), `aerys-eye-${timestamp}-${i}.png`);
					const capRes = await eyeDriver.capture.capture(rawPath, v.geometry).catch((e: unknown) => ({ code: 1, stderr: String(e) }));
					if (capRes.code !== 0) return { spec: v, rawPath, finalPath, error: `capture failed (${eyeDriver.id}): ${capRes.stderr}` };
					const resizeRes = await runCmd("convert", [rawPath, "-resize", `${maxWidth}x${maxHeight}>`, finalPath]);
					const out = resizeRes.code === 0 && fs.existsSync(finalPath) ? finalPath : rawPath;
					let frame: InputFrame | null = null;
					try {
						// Per-view frame anchor: each view's clickTargets map to ITS
						// own crop/window, so a word read in a fovea crop clicks at
						// the right physical spot even though the wide view was
						// captured separately. The LAST successful view becomes
						// lastInputFrame (matches the single-view contract).
						frame = await rememberFrame(v.window, v.geometry, rawPath, out);
					} catch {}
					return { spec: v, rawPath, finalPath: out, frame };
				}),
			);

			const okViews = captures.filter(c => !("error" in c) || !c.error);
			if (okViews.length === 0) {
				const firstErr = captures.find(c => "error" in c && c.error) as { error: string } | undefined;
				return {
					content: [{ type: "text", text: `live_eye capture failed (${eyeDriver.id}): ${firstErr?.error ?? "unknown"}` }],
					details: { error: firstErr?.error ?? "unknown", swept, driver: eyeDriver.id },
				};
			}

			const modelSeesImages = this.session?.supportsVision?.() ?? true;
			// textOnly means "words, not pixels" — it must imply OCR, otherwise a
			// vision-default caller asking textOnly gets neither pixels nor text.
			const wantOcr = params.ocr ?? (!modelSeesImages || textOnly);
			// Explicit ocr:false on the eye = words deliberately unread →
			// block lazy target hydration for this reading (contract: ocr:false
			// clears targets, a click then refuses).
			lastCaptureOcrOptOut = params.ocr === false;
			const ocrMs0 = Date.now();

			// ---- OCR every view concurrently; per-view text + click targets ----
			const readings = await Promise.all(
				captures.map(async (c): Promise<{ label: string; desc: string; text: string; ocrError?: string; ocrMode?: "native" | "upscaled"; targets: ClickTarget[]; frame: InputFrame | null; windowRect?: ActiveGeometry; base64: string; filePath?: string; error?: unknown }> => {
					if ("error" in c && c.error) {
					// Window rect travels with the reading so the continuous
					// observation can prove scene identity from the cheap focus
					// probe instead of demanding a fresh glance per action.
					const w = c.spec.window;
					const windowRect = w && w.size[0] > 0 && w.size[1] > 0 ? { at: w.at, size: w.size } : undefined;
					return { label: c.spec.label, desc: c.spec.desc, windowRect, error: c.error, text: "", targets: [], frame: null as InputFrame | null, base64: "", filePath: undefined };
					}
					let ocrText = "";
					let ocrError: string | undefined;
					let ocrMode: "native" | "upscaled" | undefined;
					let targets: ClickTarget[] = [];
					if (wantOcr && c.finalPath) {
						const ocr = await ocrFrame(c.finalPath, { lang: params.ocrLang });
						ocrText = ocr.text;
						ocrError = ocr.error;
						ocrMode = ocr.mode;
						if (ocrText) {
							// Durable copy: the eye-glance steer is swept by the next
							// glance, so record the full reading in the watch
							// transcript (the book). Multi-view lines carry the view
							// label so the book stays legible.
							CameraWatchLoop.recordExternalOcr(ocrText, "eye");
							rememberOcrText(ocrText);
						}
						targets = clickTargetsFromOcr(ocr.words, c.frame ?? null);
					}
					let base64 = "";
					if (includeBase64 && !textOnly && c.finalPath) {
						try {
							base64 = (await fs.promises.readFile(c.finalPath)).toString("base64");
						} catch {}
					}
					const wOk = c.spec.window;
					const windowRectOk = wOk && wOk.size[0] > 0 && wOk.size[1] > 0 ? { at: wOk.at, size: wOk.size } : undefined;
					return { label: c.spec.label, desc: c.spec.desc, text: ocrText, ocrError, ocrMode, targets, frame: c.frame ?? null, windowRect: windowRectOk, base64, filePath: c.finalPath };
				}),
			);

			// rememberClickTargets: merge every view's targets so a word seen in
			// ANY view is clickable (each target is already in its own frame's
			// px space; resolveClickTarget only needs text → frame px of the
			// anchored lastInputFrame, which is the last view's frame — when
			// views differ, the reading header says which frame each word
			// belongs to via per-view click-target lists).
			const allTargets = readings.flatMap(r => r.targets);
			if (allTargets.length > 0) rememberClickTargets(allTargets);
			if (wantOcr) {
				for (const r of readings) {
					if (r.text) rememberOcrText(r.text);
				}
			}

			// ---- Build the combined reading (one steer, N sections) ----
			const multi = viewSpecs.length > 1;
			const sections: string[] = [];
			const steerContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
			const sweepNote = swept > 0 ? ` swept ${swept} older eye image(s)` : " no older eye images in context";
			for (const r of readings) {
				const header = multi
					? `── Eye view [${r.label}] ${r.desc} (ephemeral — replaced next glance;${sweepNote})${r.frame ? ` Frame ${r.frame.scaledW}x${r.frame.scaledH} (window @ ${r.frame.atX},${r.frame.atY})` : ""} — this view's clickTargets are frame px of THIS crop.`
					: `Eye view of ${r.desc} (ephemeral — replaced next glance;${sweepNote}).${r.frame ? ` Frame ${r.frame.scaledW}x${r.frame.scaledH}${r.frame.kind === "window" ? ` (window @ ${r.frame.atX},${r.frame.atY})` : " (fullscreen)"} — clickTargets and live_* pointer coordinates are frame px of this glance.` : ""}`;
				const lines: string[] = [header];
				if (r.error) lines.push(`Capture failed: ${r.error}`);
				else if (r.text) {
					lines.push(
						`On-screen text (${r.text.length} chars, tesseract ${r.ocrMode ?? "native"}):`,
						r.text.length > 8000 ? `${r.text.slice(0, 8000)}\n…[truncated]` : r.text,
					);
					const ct = formatClickTargets(r.targets);
					if (ct) lines.push(ct);
				} else if (wantOcr && r.ocrError) lines.push(`OCR failed: ${r.ocrError}`);
				else if (wantOcr) lines.push("OCR produced no text (frame may contain no readable text).");
				const section = lines.join("\n");
				sections.push(section);
				steerContent.push({ type: "text", text: section });
				// Pixels ride ONLY for vision-capable models (see single-view note).
				if (modelSeesImages && r.base64) {
					steerContent.push({ type: "image", data: r.base64, mimeType: "image/png" });
				}
			}
			const reading = sections.join("\n\n");

			let attached = false;
			const eyeSession = this.session;
			if (eyeSession && "sendCustomMessage" in eyeSession) {
				try {
					await eyeSession.sendCustomMessage?.(
						{
							customType: "eye-glance",
							content: steerContent,
							display: false,
							details: {
								liveEye: { at: timestamp },
								// Primary file path stays the first successful view
								// (back-compat); every view is listed in views[].
								filePath: readings.find(r => r.filePath)?.filePath,
								targetDesc: multi ? `${readings.length} views` : readings[0]?.desc,
								...(multi ? { views: readings.map(r => ({ label: r.label, desc: r.desc, filePath: r.filePath, frame: r.frame, ...(r.windowRect ? { windowRect: r.windowRect } : {}), error: r.error ?? undefined })) } : {}),
								...(allTargets.length > 0 ? { clickTargets: allTargets } : {}),
							},
							attribution: "agent",
						},
						{ deliverAs: "steer", triggerTurn: false },
					);
					attached = true;
				} catch {
					// Fire-and-forget; if the session is shutting down we
					// just fall back to returning the text inline below.
				}
			}

			return {
				content: [
					{
						type: "text",
						text: attached
							? multi
								? `Eye glance at ${readings.length} views (${viewSpecs.map(v => v.label).join(", ")}) — readings attached for the model (ephemeral — replaced next glance; swept ${swept}).`
								: `Eye glance at ${readings[0]?.desc} — reading attached for the model (ephemeral — replaced next glance; swept ${swept}).`
							: reading,
					},
				],
				details: {
					action: "live_eye",
					liveEye: { at: timestamp },
					filePath: readings.find(r => r.filePath)?.filePath,
					targetDesc: multi ? `${readings.length} views` : readings[0]?.desc,
					swept,
					...(multi ? { views: readings.map(r => ({ label: r.label, desc: r.desc, filePath: r.filePath, frame: r.frame, ...(r.windowRect ? { windowRect: r.windowRect } : {}), error: r.error ?? undefined })) } : {}),
					...(wantOcr
						? {
								ocrText: readings.map(r => r.text).join("\n\n"),
								ocrMode: readings[0]?.ocrMode,
								ocrMs: Date.now() - ocrMs0,
								...(readings.find(r => r.ocrError) ? { ocrError: readings.find(r => r.ocrError)?.ocrError } : {}),
							}
						: {}),
					...(allTargets.length > 0 ? { clickTargets: allTargets } : {}),
					// Continuous observation anchor: the LAST successful view's
					// window frame becomes the session snapshot (address-exact,
					// fail-closed). Multi-view glances anchor the last view so
					// input always uses one unambiguous coordinate space.
					...anchorLiveObservation(readings),
				} as unknown as Record<string, unknown>,
			};
			}

			case "highlight": {
				// The eye's laser pointer: point at what was just read. Pure
				// visual draw on a layer-shell OVERLAY surface — click-through,
				// unfocusable, auto-fades. Read-tier (no D004 gate): it changes
				// nothing, injects nothing, and must work over terminals too
				// (the restricted-app refusal applies to live_type/live_click
				// only, not to drawing above a window).
				const hl = params.highlight ?? {};
				const ms = hl.ms ?? 3000;
				const width = hl.width ?? 4;
				const style = hl.style ?? "highlighter";
				const pad = style === "highlighter" ? 5 : 6;

				// Resolve words → frame-px boxes from the last reading (same
				// matcher as live_click target), plus any raw regions.
				const wantWords = hl.targets ?? [];
				const wordRects: FrameRect[] = [];
				const missing: string[] = [];
				for (const t of wantWords) {
					const hit = resolveClickTarget(t);
					if (hit) {
						const b = hit.box;
						wordRects.push({ x: b.x, y: b.y, w: b.w, h: b.h });
					} else {
						missing.push(t);
					}
				}
				const rawRects: FrameRect[] = (hl.regions ?? []).map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
				const allRects = [...wordRects, ...rawRects];
				if (allRects.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Nothing to highlight.${missing.length ? ` No remembered OCR word matches: ${missing.map(m => `"${m}"`).join(", ")}.` : ""} Take a live_eye reading first (words come from its clickTargets), or pass frame-px regions.`,
							},
						],
						details: { error: "nothing_to_highlight", missing },
					};
				}

				// Frame-px → physical px. Each rect uses the frame it was read
				// in; the module-level lastInputFrame is the anchored frame of
				// the most recent capture (multi-view readings anchor per view,
				// and merged click targets carry their own view's frame space —
				// for cross-view word sets re-eye with those views first).
				const frame = lastInputFrame;
				if (!frame) {
					return {
						content: [{ type: "text", text: "No frame anchored yet — take a live_eye glance first so the highlight has a coordinate space." }],
						details: { error: "no_frame" },
					};
				}
				const physical: HighlightRect[] = [];
				for (const r of allRects) {
					const p = frameRectToPhysical(frame, r);
					if (p) physical.push(p);
				}
				if (physical.length === 0) {
					return {
						content: [{ type: "text", text: "All highlight rects fell outside the anchored frame — re-eye and retry." }],
						details: { error: "out_of_bounds" },
					};
				}

				// Spawn the overlay: self-contained python/gtk-layer-shell script
				// that paints the bands for `ms`, dissolves, and exits.
				// Fire-and-forget with a completion log; errors surface in the
				// result but never block the session.
				//
				// Physical bands → layer-shell surface geometry. Reserved zones
				// (waybar) shrink the usable area the surface gets positioned in
				// and margins are LOGICAL — compensate for both, or every mark
				// lands ~68px low on a waybar box.
				const scale = await detectOutputScale();
				const reservedArea = await detectReservedArea();
				// Neighbouring bands merge into continuous marker strokes, so a
				// whole painted line reads as one clean stroke, not a lumpy blob.
				const bands = mergeBands(toBands(physical, { pad, style }));
				const geom = layerGeometry(bands, { reserved: reservedArea, scale });
				if (!geom) {
					return {
						content: [{ type: "text", text: "Highlight geometry collapsed — nothing to draw." }],
						details: { error: "no_geometry" },
					};
				}
				const script = highlightOverlayScript(geom, { color: hl.color, ms, width, style });
				const scriptPath = path.join(os.tmpdir(), `aerys-hl-${Date.now()}.py`);
				await fs.promises.writeFile(scriptPath, script, "utf8");
				const drawP = execFileAsync("python3", [scriptPath], { timeout: ms + 10_000 })
					.then(() => fs.promises.unlink(scriptPath).catch(() => {}))
					.catch((e: unknown) => {
						fs.promises.unlink(scriptPath).catch(() => {});
						return { error: String((e as { message?: string }).message ?? e) };
					});

				const bb = boundingBox(physical);
				const mark = style === "box" ? "boxes" : "bands";
				const drew = `${physical.length} ${mark} at frame ${frame.scaledW}x${frame.scaledH}${frame.kind === "window" ? ` (window @ ${frame.atX},${frame.atY})` : ` @ ${frame.atX},${frame.atY}`} — dissolves after ${ms}ms${missing.length ? ` (no match for: ${missing.map(m => `"${m}"`).join(", ")})` : ""}`;
				const lead = `Highlighted ${drew}`;

				// Hidden steer carries what was pointed at (the visible result
				// stays a one-liner, same contract as the eye glance).
				const steerText = `Highlight drawn: ${drew}\nRects (physical px): ${physical.map(r => `(${r.x},${r.y} ${r.w}x${r.h})`).join(" ")}${bb ? `\nBounds: ${bb.x},${bb.y} ${bb.w}x${bb.h}` : ""}\nOverlay surface: ${geom.marginLeft},${geom.marginTop} ${geom.width}x${geom.height} (reserved ${reservedArea.top}px top, scale ${scale})`;
				if (this.session && "sendCustomMessage" in this.session) {
					try {
						await this.session.sendCustomMessage?.(
							{
								customType: "eye-highlight",
								content: [{ type: "text", text: steerText }],
								display: false,
								details: { highlight: { at: Date.now(), ms, style, color: highlightColor(hl.color), rects: physical, geometry: geom } },
								attribution: "agent",
							},
							{ deliverAs: "steer", triggerTurn: false },
						);
					} catch {
						// fire-and-forget
					}
				}
				// Don't await the full fade — report immediately (overlay is
				// independent); keep the promise alive so errors are logged.
				void drawP;
				return {
					content: [{ type: "text", text: lead }],
					details: { highlight: { at: Date.now(), ms, style, color: highlightColor(hl.color), count: physical.length, rects: physical, geometry: geom, missing } },
				};
			}
		}
	}
}
