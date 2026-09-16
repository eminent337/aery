import { CameraWatchLoop } from "./camera-control";
import { detectOutputScale, detectPlatformDriver, physicalToLogical } from "./desktop-drivers";
import { buildEyeGeometry, describeEyeTarget } from "./live-eye";
import { ocrFrame } from "./screen-ocr";
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

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";
import {
	frameToPhysical,
	hyprMoveCursor,
	type InputFrame,
	type InputKind,
	isDirectTypeable,
	ensureYdotoold,
	type LiveBackend,
	parseChord,
	probeBackends,
	resolveBackendChain,
	resolveBackend,
	specToXdotoolArgs,
	specToYdotoolEvents,
	splitForEnterTyping,
	wtypeChord,
	xdoClick,
	xdoDrag,
	xdoMove,
	YDO_CTRL_V,
	YDO_DOWN,
	YDO_LEFT,
	YDO_MIDDLE,
	YDO_RIGHT,
	YDO_UP,
	ydoClickButton,
	ydoKeyEvents,
	ydoMove,
} from "./live-input";

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
			"xvfb_type",
			"xvfb_key",
			"xvfb_close",
		])
		.describe(
			"Actions: 'live_eye' is your own eyes, exactly like a human's — look whenever you want to look, any time, any reason, no permission needed. A fast sub-second glance at the environment: active window, fullscreen, a window by name, or a physical-pixel region. The glance attaches to your context as a hidden reading — OCR text on every visionless model, pixels + OCR on vision-capable models — and never renders in the transcript. Eye views are ephemeral: each glance sweeps the previous one from context, so glance freely and as often as you want. Other actions: 'screenshot' captures display/window and returns the frame inline in the result (visible), 'list_windows' lists open GUI apps, 'focus_window' brings app to front, 'close_window' closes a window, 'switch_workspace' changes workspace, 'launch_app' spawns a VISIBLE app on the desktop, 'cursor_pos' gets mouse coordinates, 'system_control' controls volume/media/brightness/lock/web search. Headless (invisible virtual display): 'xvfb_launch' runs a desktop app invisibly, 'xvfb_screenshot' captures its UI, 'xvfb_list_windows' lists windows on the virtual display, 'xvfb_click'/'xvfb_type'/'xvfb_key' drive the app, 'xvfb_close' ends it all. LIVE app-control on the real desktop (opt-in via 'live_mode_on'): 'live_move'/'live_click'/'live_drag'/'live_type'/'live_key'/'live_scroll' inject input into the FOCUSED window. Use 'live_mode_off' to disable.",
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
			"X pixel coordinate — 'xvfb_click' frame (virtual display origin top-left) or 'live_click'/'live_drag'/'live_move' model-visible screenshot frame px.",
		),
	y: z.number().int().optional().describe("Y pixel coordinate — see 'x'."),
	x2: z.number().int().optional().describe("End X pixel coordinate for 'live_drag' (same frame as 'x')."),
	y2: z.number().int().optional().describe("End Y pixel coordinate for 'live_drag' (same frame as 'y')."),
	keys: z
		.string()
		.optional()
		.describe(
			"Text for 'xvfb_type'/'live_type' (literal text, newlines become Enter) or key spec for 'xvfb_key'/'live_key' (names like Return, Tab, ctrl+l, super+Return, space; multiple separated by spaces).",
		),
	button: z
		.enum(["left", "right", "middle"])
		.optional()
		.describe("Mouse button for 'live_click'/'live_drag' (default: left)."),
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
			"Target selector, meaning depends on action: for 'live_click'/'live_move' it is click-target text matched against an OCR word from the last eye/screenshot (e.g. \"Compose\", \"Send\") and resolved to that word's frame-px center instead of raw x/y; for 'live_eye'/'screenshot' it is what to look at ('fullscreen' — default for the eye — 'active_window', or a substring of a window title/class).",
		),
	direction: z
		.enum(["up", "down"])
		.optional()
		.describe(
			"Scroll direction for 'live_scroll' (default: down). Native Wayland wheel needs uinput REL_WHEEL which ydotool does not expose — 'live_scroll' on a native window emulates Page_Up/Page_Down.",
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
	const probe = await runCmd("sh", ["-c", `DISPLAY=${XVFB_DISPLAY} xdotool getdisplaygeometry`]);
	if (probe.code === 0) return;
	const up = await runCmd("sh", [
		"-c",
		`nohup Xvfb ${XVFB_DISPLAY} -screen 0 ${XVFB_GEOMETRY} >/dev/null 2>&1 & sleep 1.5`,
	]);
	if (up.code !== 0) throw new Error(`Failed to start Xvfb: ${up.stderr}`);
	const check = await runCmd("sh", ["-c", `DISPLAY=${XVFB_DISPLAY} xdotool getdisplaygeometry`]);
	if (check.code !== 0) throw new Error("Xvfb started but not responding");
}

function xvfbCommandFixup(cmd: string): string {
	// Wayland-native apps refuse to fall back to X11 silently — force it.
	if (/\b(brave|chromium|google-chrome|msedge|electron|code)\b/.test(cmd) && !cmd.includes("--ozone-platform")) {
		return cmd.replace(/^(flatpak run \S+|[^ ]+\.AppImage|\S+)/, "$& --ozone-platform=x11");
	}
	return cmd;
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

/** Record the coordinate frame of a finished capture (window or fullscreen).
 *  `geometry` is the grim-style "X,Y WxH" crop string; when the capture was a
 *  plain region (no window), the frame anchors at the CROP ORIGIN — otherwise
 *  a region view's frame px would map clicks to the top-left of the screen
 *  instead of where the crop actually sits. */
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
 *  Exported for tests to seed the matcher, and used by eye/screenshot. */
export function rememberClickTargets(targets: ClickTarget[]): void {
	lastClickTargets = targets;
}

/** Resolve a `target` text ("Compose", "Send") to the best remembered click
 *  target. Case-insensitive substring match; prefers earlier (topmost)
 *  matches so "OK" hits the dialog button, not body text. Returns frame-px
 *  center of the box. */
export function resolveClickTarget(text: string): { x: number; y: number; box: ClickTarget } | null {
	const q = text.trim().toLowerCase();
	if (!q) return null;
	const matches = lastClickTargets.filter(t => t.text.toLowerCase().includes(q));
	if (matches.length === 0) return null;
	// Prefer exact match, then shortest text (a button label beats a
	// sentence containing the word), then topmost.
	const best = matches.sort((a, b) => {
		const ea = a.text.toLowerCase() === q ? 0 : 1;
		const eb = b.text.toLowerCase() === q ? 0 : 1;
		if (ea !== eb) return ea - eb;
		if (a.text.length !== b.text.length) return a.text.length - b.text.length;
		return a.y - b.y || a.x - b.x;
	})[0];
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
	frame: { scaledW: number; scaledH: number; kind: string; address?: string } | null;
	focusedAddress: string | undefined;
}): { ok: true; tx?: number; ty?: number } | { ok: false; error: string; code: string } {
	const isPointer = params.action === "live_move" || params.action === "live_click" || params.action === "live_drag";
	// 1. Guardrails first (cheapest, no frame needed).
	const refusal = guardrailRefusal(params.action, { target: params.target, keys: params.keys });
	if (refusal) return { ok: false, error: refusal, code: "guardrail_refusal" };
	// Restricted-app check needs the window — represented here by class/title
	// passed via keys-free params; the live path re-checks with the real win.
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
					error: `No remembered OCR word matches "${params.target}". Take an eye/screenshot of the window first; live_click target matches words from the last reading (e.g. "Compose", "Send").`,
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

/** Run argv steps sequentially with a small inter-step sleep. Returns error|null. */
async function runSteps(steps: string[][], interStepMs = 30): Promise<string | null> {
	for (const argv of steps) {
		const res = await runCmd(argv[0], argv.slice(1), { timeout: 8000 });
		if (res.code !== 0) return `"${argv[0]} ${argv.slice(1).join(" ")}" failed: ${res.stderr || res.stdout}`;
		if (interStepMs > 0) await new Promise(r => setTimeout(r, interStepMs));
	}
	return null;
}

/**
 * Type text trying backends in chain order until one succeeds.
 * ASCII goes direct (ydotool type / wtype text / xdotool type); non-ASCII
 * pastes via wl-copy + Ctrl+V (ydotool) or wl-copy + Ctrl+V via backend keys.
 * Returns null on success, else the last error.
 */
async function typeTextWith(chain: LiveBackend[], text: string): Promise<string | null> {
	let lastErr: string | null = null;
	for (const backend of chain) {
		if (backend === "ydotool") {
			if (isDirectTypeable(text)) {
				const res = await runCmd("ydotool", ["type", text]);
				if (res.code === 0) return null;
				lastErr = `ydotool type failed: ${res.stderr}`;
				continue;
			}
			const copy = await runCmd("wl-copy", [text]);
			if (copy.code !== 0) {
				lastErr = `wl-copy failed: ${copy.stderr}`;
				continue;
			}
			const paste = await runCmd("ydotool", ["key", "-d", "24", ...YDO_CTRL_V]);
			if (paste.code === 0) return null;
			lastErr = `paste (Ctrl+V) failed: ${paste.stderr}`;
			continue;
		}
		const lines = splitForEnterTyping(text);
		let ok = true;
		let err: string | null = null;
		for (let i = 0; i < lines.length && ok; i++) {
			if (lines[i]) {
				const res =
					backend === "xdotool"
						? await runCmd("xdotool", ["type", "--delay", "40", lines[i]])
						: await runCmd("wtype", [lines[i]]);
				if (res.code !== 0) {
					ok = false;
					err = `${backend} type failed: ${res.stderr}`;
				}
			}
			if (ok && i < lines.length - 1) {
				const res =
					backend === "xdotool"
						? await runCmd("xdotool", ["key", "--clearmodifiers", "Return"])
						: await runCmd("wtype", ["-k", "Return"]);
				if (res.code !== 0) {
					ok = false;
					err = `${backend} Enter failed: ${res.stderr}`;
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
async function keyTextWith(chain: LiveBackend[], spec: string): Promise<string | null> {
	let lastErr: string | null = null;
	for (const backend of chain) {
		if (backend === "ydotool") {
			const events = specToYdotoolEvents(spec);
			if ("error" in events) {
				lastErr = events.error;
				continue;
			}
			const fail = await runSteps([ydoKeyEvents(events)]);
			if (!fail) return null;
			lastErr = fail;
		} else if (backend === "xdotool") {
			const names = specToXdotoolArgs(spec);
			if ("error" in names) {
				lastErr = names.error;
			continue;
			}
			const fail = await runSteps([["xdotool", "key", "--clearmodifiers", ...names]]);
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
				const fail = await runSteps([chord.argv]);
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
/** Execute one live_* action (module-level so the execute() switch stays tiny). */
async function executeLiveAction(
	action: string,
	params: DesktopControlParams,
	session?: ToolSession,
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
		const pre = params.preAuthorize?.length ? ` Pre-authorized: ${params.preAuthorize.join(", ")}.` : "";
		return okText(
			`App-control mode is ON. live_* actions may drive the focused window on your real desktop. Peter stays in control: the first use of each action kind prompts for approval.${pre}${daemonUp ? "" : " Warning: ydotool input daemon could not be started — injection may fail (see live_backend_probe)."}`,
			{ liveMode: true, ydotoold: daemonUp, preAuthorized: params.preAuthorize ?? [] },
		);
	}
	if (action === "live_mode_off") {
		liveModeEnabled = false;
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
			`App-control mode: ${liveModeEnabled ? "ON" : "OFF"}`,
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
const withVerify = async (lead: string): Promise<AgentToolResult> => {
	// Drive-loop bookkeeping: reaching verify means the injection ran.
	// Central success observation for every live_* branch (clippy pattern).
	driveLoopObserve(action, true, action === "live_scroll" ? (params.direction ?? undefined) : undefined, stepKey);
	if (!verify) return okText(lead);
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
	if ("error" in cap) return okText(`${lead} (verify screenshot failed: ${cap.error})`);
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
		return okText(
			`${lead}${attached ? " — verify frame attached for the model." : " (verify frame could not be attached; verify:false to skip)"}`,
			{ success: true, frame: cap.frame, steerAttached: attached, swept },
		);
	};


	// Validate-before-run: every fail-without-touching check (guardrails,
	// frame presence/staleness, target resolution, bounds) runs BEFORE any
	// backend subprocess. Failures stop and ask — nothing is injected.
	const validation = validateInjection({
		action,
		x: params.x,
		y: params.y,
		x2: params.x2,
		y2: params.y2,
		target: params.target,
		keys: params.keys,
		frame: lastInputFrame,
		focusedAddress: win.address,
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
		const aim = detectPlatformDriver().id === "hyprland" ? hyprMoveCursor(logical.x, logical.y) : null;
		if (action === "live_move") {
			const fail = await runSteps(
				aim ? [aim] : backend === "ydotool" ? [ydoMove(pt.x, pt.y)] : [xdoMove(pt.x, pt.y)],
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
						? [aim, ydoClickButton(code, count)]
						: [ydoMove(pt.x, pt.y), ydoClickButton(code, count)]
					: [xdoClick(pt.x, pt.y, button, count)];
			const fail = await runSteps(steps);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			return withVerify(
				`${count > 1 ? `${count}× ` : ""}${button} click ${params.target ? `"${params.target}" ` : ""}frame (${tx},${ty}) → physical (${pt.x},${pt.y}) on "${win.title}".`,
			);
		}
		if (action === "live_drag") {
			const end = frameToPhysical(frame, params.x2!, params.y2!);
			let steps: string[][];
			if (backend === "ydotool") {
				steps = aim ? [aim, ydoClickButton(YDO_DOWN)] : [ydoMove(pt.x, pt.y), ydoClickButton(YDO_DOWN)];
				for (let i = 1; i <= 6; i++) {
					const mx = pt.x + ((end.x - pt.x) * i) / 6;
					const my = pt.y + ((end.y - pt.y) * i) / 6;
					// Waypoints interpolate in physical px; aim calls need logical.
					const wl = physicalToLogical(mx, my, scale);
					steps.push(aim ? hyprMoveCursor(wl.x, wl.y) : ydoMove(wl.x, wl.y));
				}
				steps.push(ydoClickButton(YDO_UP));
			} else {
				steps = [xdoDrag(pt.x, pt.y, end.x, end.y)];
			}
			const fail = await runSteps(steps, 24);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			return withVerify(`Dragged frame (${params.x},${params.y}) → (${params.x2},${params.y2}).`);
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
		const fail = await typeTextWith(chain, text);
		if (fail) return errObserve(action, fail);
		liveAuthorizedKinds.add(action);
		return withVerify(`Typed ${text.length} chars into "${win.title}"${chain[0] !== "ydotool" ? ` (backend: ${chain[0]})` : ""}.`);
	}

	if (action === "live_key") {
		const spec = params.keys ?? "";
		if (chain.length === 0) {
			return errText(
				`No keyboard backend available (need ydotool+daemon, wtype, or xdotool on XWayland). Probe: ydotool=${probe.ydotool}/${probe.ydotoold ? "up" : "down"}, wtype=${probe.wtype}, xdotool=${probe.xdotool}.`,
				"no_backend",
			);
		}
		const fail = await keyTextWith(chain, spec);
		if (fail) return errObserve(action, fail);
		liveAuthorizedKinds.add(action);
		return withVerify(`Sent keys "${spec}" to "${win.title}"${chain[0] !== "ydotool" ? ` (backend: ${chain[0]})` : ""}.`);
	}

	if (action === "live_scroll") {
		const dir = params.direction ?? "down";
		const count = Math.min(params.count ?? 1, 20);
		if (backend === "xdotool") {
			const btn = dir === "up" ? "4" : "5";
			const fail = await runSteps([["xdotool", "click", "--repeat", String(count), "--delay", "60", btn]]);
			if (fail) return errObserve(action, fail);
			liveAuthorizedKinds.add(action);
			return withVerify(`Wheel-scrolled ${dir} ${count}× on XWayland window "${win.title}".`);
		}
		if (backend === "wtype")
			return errText(
				"wtype is keyboard-only and cannot scroll. Use live_key Page_Up/Page_Down on a native window, or install ydotool + a uinput wheel path.",
				"no_scroll",
			);
		// ydotool: no REL_WHEEL in v1 — emulate Page_Up / Page_Down.
		// Coalesced: count rides in ONE ydotool call (no per-step sleep),
		// and with verify:false the settle/verify capture is skipped, so a
		// multi-step scroll is one fast call + the caller's re-eye.
		const token = dir === "up" ? "pageup" : "pagedown";
		const chord = parseChord(token);
		const events: string[] = [];
		if (chord) for (let i = 0; i < count; i++) events.push(`${chord[0]}:1`, `${chord[0]}:0`);
		const fail = await runSteps([ydoKeyEvents(events)], 0);
		if (fail) return errObserve(action, fail);
		liveAuthorizedKinds.add(action);
		return withVerify(
			`Scrolled ${dir} ${count}× (Page_${dir === "up" ? "Up" : "Down"} emulation — ydotool has no wheel).`,
		);
	}

	return errText(`Unhandled live action "${action}".`, "unhandled");
}

export class DesktopControlTool implements AgentTool<typeof desktopControlSchema> {
	readonly name = "desktop_control";
	readonly approval = liveApprovalDecision;
	readonly label = "Desktop Control";
	readonly description =
		"Desktop screen vision and window manager tool. Takes full-screen or window-targeted screenshots with DPI scaling, lists open windows, focuses or closes applications, and manages workspaces.";
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

	async execute(_id: string, params: DesktopControlParams): Promise<AgentToolResult> {
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
				return executeLiveAction(params.action, params, this.session);
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
					// give GUI apps a beat to map their window, then report what's on the display
					await new Promise(r => setTimeout(r, 4000));
					const windows = await xvfbListWindows();
					return {
						content: [
							{
								type: "text",
								text: `Launched '${params.command}' invisibly on the virtual display.${windows.length ? ` Windows now present: ${windows.join(" | ")}` : " No window mapped yet (may still be loading) — check with xvfb_list_windows or xvfb_screenshot."}`,
							},
						],
						details: { command: params.command, headless: true, windows },
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
					const buf = fs.readFileSync(outPath);
					const size = buf.length;
					return {
						content: [
							{ type: "text", text: `Captured the headless virtual display (${XVFB_GEOMETRY}) → ${outPath}.` },
							...(size > 500 && (params.includeBase64 ?? true)
								? [{ type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" }]
								: []),
							...(size <= 500
								? [
										{
											type: "text" as const,
											text: "Note: capture looks empty (no windows on the virtual display?).",
										},
									]
								: []),
						],
						details: { file: outPath, bytes: size, headless: true },
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
				if (params.x === undefined || params.y === undefined) {
					return {
						content: [
							{
								type: "text",
								text: "Error: 'x' and 'y' pixel coordinates are required for xvfb_click (see the xvfb_screenshot image for where to click).",
							},
						],
					};
				}
				await xvfbEnsureServer();
				const btn = params.target && /right|middle/.test(params.target) ? params.target : "left";
				const res = await runCmd("xdotool", ["mousemove", String(params.x), String(params.y), "click", btn], {
					env: xvfbEnv(),
				});
				return res.code === 0
					? {
							content: [
								{ type: "text", text: `Clicked ${btn} at ${params.x},${params.y} on the headless display.` },
							],
						}
					: { content: [{ type: "text", text: `xvfb_click failed: ${res.stderr}` }] };
			}

			case "xvfb_type": {
				if (!params.keys) {
					return {
						content: [{ type: "text", text: "Error: 'keys' (the text to type) is required for xvfb_type." }],
					};
				}
				await xvfbEnsureServer();
				const res = await runCmd("xdotool", ["type", "--delay", "40", params.keys], { env: xvfbEnv() });
				return res.code === 0
					? { content: [{ type: "text", text: `Typed text into the focused headless window.` }] }
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
				const res = await runCmd("xdotool", ["key", params.keys], { env: xvfbEnv() });
				return res.code === 0
					? { content: [{ type: "text", text: `Sent keys '${params.keys}' to the headless display.` }] }
					: { content: [{ type: "text", text: `xvfb_key failed: ${res.stderr}` }] };
			}

			case "xvfb_close": {
				// close all windows on the virtual display, then optionally kill apps
				const wins = await xvfbListWindows();
				const env = xvfbEnv();
				for (const w of wins) {
					await runCmd("xdotool", ["search", "--name", w, "windowclose"], { env });
				}
				await runCmd("sh", ["-c", `pkill -f "DISPLAY=${XVFB_DISPLAY}" 2>/dev/null; true`]);
				await runCmd("pkill", ["Xvfb"]).catch?.(() => {});
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
				if (isSupportedDriver()) {
					try {
						const remembered = await rememberFrame(targetWindow, geometry, tmpRaw, finalPath);
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
				// pixel-first result unless they pass ocr:true.
				const shotModelSeesImages = this.session?.supportsVision?.() ?? true;
				const shotWantOcr = params.ocr ?? !shotModelSeesImages;
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
			const wantOcr = params.ocr ?? !modelSeesImages;
			const ocrMs0 = Date.now();

			// ---- OCR every view concurrently; per-view text + click targets ----
			const readings = await Promise.all(
				captures.map(async c => {
					if ("error" in c && c.error) {
						return { label: c.spec.label, desc: c.spec.desc, error: c.error, text: "", targets: [], frame: null as InputFrame | null };
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
						targets = clickTargetsFromOcr(ocr.words, c.frame);
					}
					let base64 = "";
					if (includeBase64 && !textOnly && c.finalPath) {
						try {
							base64 = (await fs.promises.readFile(c.finalPath)).toString("base64");
						} catch {}
					}
					return { label: c.spec.label, desc: c.spec.desc, text: ocrText, ocrError, ocrMode, targets, frame: c.frame ?? null, base64, filePath: c.finalPath };
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
								...(multi ? { views: readings.map(r => ({ label: r.label, desc: r.desc, filePath: r.filePath, frame: r.frame })) } : {}),
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
					...(multi ? { views: readings.map(r => ({ label: r.label, desc: r.desc, filePath: r.filePath, frame: r.frame, error: r.error ?? undefined })) } : {}),
					...(wantOcr
						? {
								ocrText: readings.map(r => r.text).join("\n\n"),
								ocrMode: readings[0]?.ocrMode,
								ocrMs: Date.now() - ocrMs0,
								...(readings.find(r => r.ocrError) ? { ocrError: readings.find(r => r.ocrError)?.ocrError } : {}),
							}
						: {}),
					...(allTargets.length > 0 ? { clickTargets: allTargets } : {}),
				} as unknown as Record<string, unknown>,
			};
			}
		}
	}
}
