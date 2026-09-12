import { buildEyeGeometry, describeEyeTarget } from "./live-eye";
import { ocrFrame } from "./screen-ocr";
/**
 * Desktop Control & Screen Vision Tool.
 *
 * Provides desktop window awareness, screen capture, DPI-aware scaling,
 * window focus/lifecycle, and workspace management.
 *
 * Designed for Wayland (Hyprland native via grim & hyprctl) with fallbacks
 * for X11 (scrot/import/xdotool) and macOS (screencapture).
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
	type LiveBackend,
	parseChord,
	probeBackends,
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
			"Actions: 'screenshot' captures display/window, 'live_eye' takes a fast glance (active window, fullscreen, a window by query, or a physical-px region) and marks it ephemeral so older eye views are swept from context at the next user prompt, 'list_windows' lists open GUI apps, 'focus_window' brings app to front, 'close_window' closes a window, 'switch_workspace' changes workspace, 'launch_app' spawns a VISIBLE app on the desktop, 'cursor_pos' gets mouse coordinates, 'system_control' controls volume/media/brightness/lock/web search. Headless (invisible virtual display): 'xvfb_launch' runs a desktop app invisibly, 'xvfb_screenshot' captures its UI, 'xvfb_list_windows' lists windows on the virtual display, 'xvfb_click'/'xvfb_type'/'xvfb_key' drive the app, 'xvfb_close' ends it all. LIVE app-control on the real desktop (opt-in via 'live_mode_on'): 'live_move'/'live_click'/'live_drag'/'live_type'/'live_key'/'live_scroll' inject input into the FOCUSED window. Use 'live_mode_off' to disable.",
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
			"Take and return a follow-up screenshot after the live action (default: true) so the model self-corrects.",
		),
	target: z
		.string()
		.optional()
		.describe(
			"Target for 'screenshot' ('fullscreen', 'active_window', or substring of window title/class). Default: 'active_window'.",
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
			"Extract on-screen text with tesseract OCR and return it as text (default: false). Use this when the model cannot see images — the glance then reads the frame's text content. Adds ~0.3-2s.",
		),
	ocrLang: z
		.string()
		.optional()
		.describe("Tesseract language for 'ocr' (default: 'eng'; requires the language pack in /usr/share/tessdata)."),
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

/** Check if running inside a Hyprland Wayland compositor */
function isHyprland(): boolean {
	return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
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

/** Get list of all open GUI windows */
async function getHyprlandWindows(): Promise<DesktopWindowInfo[]> {
	const res = await runCmd("hyprctl", ["clients", "-j"]);
	if (res.code !== 0) return [];
	try {
		const raw = JSON.parse(res.stdout) as Array<{
			address: string;
			title: string;
			class: string;
			workspace?: { id: number; name: string };
			at: [number, number];
			size: [number, number];
			focusHistoryID: number;
			xwayland?: boolean;
			pid?: number;
		}>;
		return raw.map(w => ({
			address: w.address,
			title: w.title || "(untitled)",
			class: w.class || "(unknown)",
			workspace: w.workspace?.name || w.workspace?.id || 1,
			at: w.at || [0, 0],
			size: w.size || [0, 0],
			focused: w.focusHistoryID === 0,
			pid: w.pid,
			xwayland: w.xwayland === true,
		}));
	} catch {
		return [];
	}
}

/** Get active focused window info */
async function getHyprlandActiveWindow(): Promise<DesktopWindowInfo | undefined> {
	const res = await runCmd("hyprctl", ["activewindow", "-j"]);
	if (res.code !== 0) return undefined;
	try {
		const w = JSON.parse(res.stdout);
		if (!w || !w.address) return undefined;
		return {
			address: w.address,
			title: w.title || "(untitled)",
			class: w.class || "(unknown)",
			workspace: w.workspace?.name || w.workspace?.id || 1,
			at: w.at || [0, 0],
			size: w.size || [0, 0],
			focused: true,
			pid: w.pid,
			xwayland: w.xwayland === true,
		};
	} catch {
		return undefined;
	}
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

/** Record the coordinate frame of a finished capture (window or fullscreen). */
async function rememberFrame(
	win: DesktopWindowInfo | undefined,
	geometry: string | undefined,
	rawPath: string,
	finalPath: string,
): Promise<InputFrame | null> {
	const raw = await identifyDims(rawPath);
	const scaled = await identifyDims(finalPath);
	if (!raw || !scaled) return null;
	const frame: InputFrame =
		geometry && win
			? {
					kind: "window",
					atX: win.at[0],
					atY: win.at[1],
					physW: raw[0],
					physH: raw[1],
					scaledW: scaled[0],
					scaledH: scaled[1],
					address: win.address,
				}
			: {
					kind: "fullscreen",
					atX: 0,
					atY: 0,
					physW: raw[0],
					physH: raw[1],
					scaledW: scaled[0],
					scaledH: scaled[1],
				};
	lastInputFrame = frame;
	return frame;
}

type LiveImageBlock = Extract<AgentToolResult["content"][number], { type: "image" }>;

interface LiveCapture {
	text: string;
	image?: LiveImageBlock;
	frame: InputFrame | null;
}

/** grim the focused window (or full display) and downscale to the vision frame. */
async function captureLiveFrame(lead: string): Promise<LiveCapture | { error: string }> {
	if (!isHyprland()) return { error: "live input requires the Hyprland/Wayland session." };
	const win = await getHyprlandActiveWindow();
	const geometry =
		win && win.size[0] > 0 && win.size[1] > 0 ? `${win.at[0]},${win.at[1]} ${win.size[0]}x${win.size[1]}` : undefined;
	const stamp = Date.now();
	const rawPath = path.join(os.tmpdir(), `aerys-live-${stamp}-raw.png`);
	const scaledPath = path.join(os.tmpdir(), `aerys-live-${stamp}.png`);
	const args: string[] = geometry ? ["-g", geometry] : [];
	args.push(rawPath);
	const cap = await runCmd("grim", args);
	if (cap.code !== 0) return { error: `grim capture failed: ${cap.stderr}` };
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
	};
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

/** Type text with the chosen backend. Newlines become Enter; non-ASCII uses wl-copy paste. */
async function typeTextWith(backend: LiveBackend, text: string): Promise<string | null> {
	if (backend === "ydotool") {
		if (isDirectTypeable(text)) {
			const res = await runCmd("ydotool", ["type", text]);
			return res.code === 0 ? null : `ydotool type failed: ${res.stderr}`;
		}
		const copy = await runCmd("wl-copy", [text]);
		if (copy.code !== 0) return `wl-copy failed: ${copy.stderr}`;
		const paste = await runCmd("ydotool", ["key", "-d", "24", ...YDO_CTRL_V]);
		return paste.code === 0 ? null : `paste (Ctrl+V) failed: ${paste.stderr}`;
	}
	const lines = splitForEnterTyping(text);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]) {
			const res =
				backend === "xdotool"
					? await runCmd("xdotool", ["type", "--delay", "40", lines[i]])
					: await runCmd("wtype", [lines[i]]);
			if (res.code !== 0) return `${backend} type failed: ${res.stderr}`;
		}
		if (i < lines.length - 1) {
			const res =
				backend === "xdotool"
					? await runCmd("xdotool", ["key", "--clearmodifiers", "Return"])
					: await runCmd("wtype", ["-k", "Return"]);
			if (res.code !== 0) return `${backend} Enter failed: ${res.stderr}`;
		}
	}
	return null;
}
/** Execute one live_* action (module-level so the execute() switch stays tiny). */
async function executeLiveAction(action: string, params: DesktopControlParams): Promise<AgentToolResult> {
	const okText = (text: string, extra?: Record<string, unknown>): AgentToolResult => ({
		content: [{ type: "text", text }],
		details: extra ?? {},
	});
	const errText = (text: string, code?: string): AgentToolResult => ({
		content: [{ type: "text", text }],
		details: code ? { error: code } : {},
	});

	// ---- mode / probe actions (harmless — never require opt-in) ----
	if (action === "live_mode_on") {
		liveModeEnabled = true;
		return okText(
			"App-control mode is ON. live_* actions may drive the focused window on your real desktop. Peter stays in control: the first use of each action kind prompts for approval.",
			{ liveMode: true },
		);
	}
	if (action === "live_mode_off") {
		liveModeEnabled = false;
		return okText("App-control mode OFF — live input disabled.", { liveMode: false });
	}
	if (action === "live_mode_status" || action === "live_backend_probe") {
		const probe = await probeBackends();
		const win = await getHyprlandActiveWindow();
		const pointer = resolveBackend(probe, win?.xwayland, "pointer");
		const keyboard = resolveBackend(probe, win?.xwayland, "keyboard");
		const frame = lastInputFrame;
		const lines = [
			`App-control mode: ${liveModeEnabled ? "ON" : "OFF"}`,
			`Backends: ydotool=${probe.ydotool} (daemon: ${probe.ydotoold ? "up" : "DOWN"}) | xdotool=${probe.xdotool} | wtype=${probe.wtype}`,
			`Focused window: ${win ? `"${win.title}" (${win.class}) — ${win.xwayland ? "XWayland" : "native Wayland"}` : "none (focus one first)"}`,
			`Resolved backend → pointer: ${pointer}${pointer === "no-daemon" ? " — start ydotoold / add the uinput udev rule" : ""}; keyboard/type: ${keyboard}`,
			`Authorized kinds: ${liveAuthorizedKinds.size ? [...liveAuthorizedKinds].join(", ") : "(none — first use of each kind prompts Peter)"}`,
			`Last screenshot frame: ${frame ? `${frame.kind} ${frame.scaledW}x${frame.scaledH}${frame.address ? ` @ ${frame.address}` : ""}` : "none — screenshot the target window first"}`,
		];
		return okText(lines.join("\n"), {
			liveMode: liveModeEnabled,
			probe,
			focused: win,
			resolvedPointer: pointer,
			resolvedKeyboard: keyboard,
			frame,
		});
	}

	// ---- injection actions: opt-in gate first ----
	if (!liveModeEnabled) {
		return errText(
			'App-control mode is OFF (D004 safety gate). Enable it with action "live_mode_on" first — live input drives your real desktop.',
			"mode_off",
		);
	}
	const probe = await probeBackends();
	const win = await getHyprlandActiveWindow();
	if (!win || !win.address) {
		return errText(
			"No focused window to drive. Focus the target app first (focus_window / hyprctl) or click it yourself.",
			"no_focused_window",
		);
	}
	const isPointer = action === "live_move" || action === "live_click" || action === "live_drag";
	const kind: InputKind =
		isPointer || action === "live_scroll" ? "pointer" : action === "live_type" ? "type" : "keyboard";
	const backend = resolveBackend(probe, win.xwayland, kind);
	if (backend === "no-daemon") {
		return errText(
			"ydotool is installed but ydotoold (its daemon) is not running. Start it with uinput access per the approved A1 design (udev rule + ydotoold) and retry.",
			"no_daemon",
		);
	}
	if (backend === "none") {
		return errText(
			`No input backend for a ${win.xwayland ? "XWayland" : "native-Wayland"} window: install ydotool + ydotoold (A1) or wtype (keyboard-only). Run live_backend_probe for the full picture.`,
			"no_backend",
		);
	}

	const verify = params.verify !== false;
	const withVerify = async (lead: string): Promise<AgentToolResult> => {
		if (!verify) return okText(lead);
		const cap = await captureLiveFrame(lead);
		if ("error" in cap) return okText(`${lead} (verify screenshot failed: ${cap.error})`);
		const content: AgentToolResult["content"] = [{ type: "text", text: cap.text }];
		if (cap.image) content.push({ type: "image", data: cap.image.data, mimeType: cap.image.mimeType });
		return { content, details: { success: true, frame: cap.frame } };
	};

	// Stale-frame guard — applies to pointer AND keyboard alike: if the last
	// window-scoped screenshot was of another window than the currently focused
	// one, refuse. Injection must land in the intended window, not whatever
	// grabbed focus since the screenshot.
	const staleFrame = lastInputFrame;
	if (staleFrame?.kind === "window" && staleFrame.address !== win.address) {
		return errText(
			`The focused window changed since the last screenshot (now "${win.title}"). Retake a screenshot of the target window, then retry.`,
			"frame_stale",
		);
	}

	if (isPointer) {
		const frame = lastInputFrame;
		if (!frame) {
			return errText(
				"No screenshot frame yet. Take a desktop_control screenshot of the target window (default active_window) first — live pointer coordinates are frame px of that image.",
				"no_frame",
			);
		}
		if (params.x === undefined || params.y === undefined) {
			return errText(`${action} requires x and y (frame px from the last screenshot).`, "missing_xy");
		}
		const pt = frameToPhysical(frame, params.x, params.y);
		// Aim with the compositor (exact); ydotool absolute moves are unreliable on
		// Hyprland (no ABS cap on the virtual device — relative deltas + accel skew).
		const aim = isHyprland() ? hyprMoveCursor(pt.x, pt.y) : null;
		if (action === "live_move") {
			const fail = await runSteps(
				aim ? [aim] : backend === "ydotool" ? [ydoMove(pt.x, pt.y)] : [xdoMove(pt.x, pt.y)],
			);
			if (fail) return errText(fail);
			liveAuthorizedKinds.add(action);
			return withVerify(`Moved pointer to frame (${params.x},${params.y}) → physical (${pt.x},${pt.y}).`);
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
			if (fail) return errText(fail);
			liveAuthorizedKinds.add(action);
			return withVerify(
				`${count > 1 ? `${count}× ` : ""}${button} click at frame (${params.x},${params.y}) → physical (${pt.x},${pt.y}) on "${win.title}".`,
			);
		}
		if (action === "live_drag") {
			if (params.x2 === undefined || params.y2 === undefined)
				return errText("live_drag requires x,y and x2,y2 (frame px).", "missing_xy2");
			const end = frameToPhysical(frame, params.x2, params.y2);
			let steps: string[][];
			if (backend === "ydotool") {
				steps = aim ? [aim, ydoClickButton(YDO_DOWN)] : [ydoMove(pt.x, pt.y), ydoClickButton(YDO_DOWN)];
				for (let i = 1; i <= 6; i++) {
					const mx = pt.x + ((end.x - pt.x) * i) / 6;
					const my = pt.y + ((end.y - pt.y) * i) / 6;
					steps.push(aim ? hyprMoveCursor(mx, my) : ydoMove(mx, my));
				}
				steps.push(ydoClickButton(YDO_UP));
			} else {
				steps = [xdoDrag(pt.x, pt.y, end.x, end.y)];
			}
			const fail = await runSteps(steps, 24);
			if (fail) return errText(fail);
			liveAuthorizedKinds.add(action);
			return withVerify(`Dragged frame (${params.x},${params.y}) → (${params.x2},${params.y2}).`);
		}
	}

	if (action === "live_type") {
		const text = params.keys ?? "";
		if (!text) return errText("live_type requires 'keys' (the text to type).", "missing_text");
		const fail = await typeTextWith(backend, text);
		if (fail) return errText(fail);
		liveAuthorizedKinds.add(action);
		return withVerify(`Typed ${text.length} chars into "${win.title}".`);
	}

	if (action === "live_key") {
		const spec = params.keys ?? "";
		if (!spec) return errText("live_key requires 'keys' (e.g. Return, ctrl+l, super+Return, space).", "missing_keys");
		if (backend === "ydotool") {
			const events = specToYdotoolEvents(spec);
			if ("error" in events) return errText(events.error);
			const fail = await runSteps([ydoKeyEvents(events)]);
			if (fail) return errText(fail);
		} else if (backend === "xdotool") {
			const names = specToXdotoolArgs(spec);
			if ("error" in names) return errText(names.error);
			const fail = await runSteps([["xdotool", "key", "--clearmodifiers", ...names]]);
			if (fail) return errText(fail);
		} else {
			for (const token of spec.trim().split(/\s+/)) {
				const chord = wtypeChord(token);
				if ("error" in chord) return errText(chord.error);
				const fail = await runSteps([chord.argv]);
				if (fail) return errText(fail);
			}
		}
		liveAuthorizedKinds.add(action);
		return withVerify(`Sent keys "${spec}" to "${win.title}".`);
	}

	if (action === "live_scroll") {
		const dir = params.direction ?? "down";
		const count = Math.min(params.count ?? 1, 20);
		if (backend === "xdotool") {
			const btn = dir === "up" ? "4" : "5";
			const fail = await runSteps([["xdotool", "click", "--repeat", String(count), "--delay", "60", btn]]);
			if (fail) return errText(fail);
			liveAuthorizedKinds.add(action);
			return withVerify(`Wheel-scrolled ${dir} ${count}× on XWayland window "${win.title}".`);
		}
		if (backend === "wtype")
			return errText(
				"wtype is keyboard-only and cannot scroll. Use live_key Page_Up/Page_Down on a native window, or install ydotool + a uinput wheel path.",
				"no_scroll",
			);
		// ydotool: no REL_WHEEL in v1 — emulate Page_Up / Page_Down.
		const token = dir === "up" ? "pageup" : "pagedown";
		const chord = parseChord(token);
		const events: string[] = [];
		if (chord) for (let i = 0; i < count; i++) events.push(`${chord[0]}:1`, `${chord[0]}:0`);
		const fail = await runSteps([ydoKeyEvents(events)]);
		if (fail) return errText(fail);
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
				return executeLiveAction(params.action, params);
			case "list_windows": {
				if (!isHyprland()) {
					return {
						content: [{ type: "text", text: "Window listing is currently supported on Hyprland/Wayland." }],
						details: { windows: [] },
					};
				}
				const windows = await getHyprlandWindows();
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
				if (!isHyprland()) {
					return {
						content: [{ type: "text", text: "Window focus is currently supported on Hyprland/Wayland." }],
						details: { error: "unsupported_compositor" },
					};
				}
				const windows = await getHyprlandWindows();
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

				const res = await runCmd("hyprctl", ["dispatch", "focuswindow", `address:${match.address}`]);
				if (res.code !== 0) {
					return {
						content: [{ type: "text", text: `Failed to focus window [${match.title}]: ${res.stderr}` }],
						details: { error: res.stderr },
					};
				}
				return {
					content: [{ type: "text", text: `Focused window: "${match.title}" (class: ${match.class})` }],
					details: { focused: match },
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
				if (!isHyprland()) {
					return {
						content: [{ type: "text", text: "Window close is currently supported on Hyprland/Wayland." }],
						details: { error: "unsupported_compositor" },
					};
				}
				const windows = await getHyprlandWindows();
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

				const res = await runCmd("hyprctl", ["dispatch", "closewindow", `address:${match.address}`]);
				if (res.code !== 0) {
					return {
						content: [{ type: "text", text: `Failed to close window [${match.title}]: ${res.stderr}` }],
						details: { error: res.stderr },
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
				if (!isHyprland()) {
					return {
						content: [{ type: "text", text: "Workspace switching is supported on Hyprland/Wayland." }],
						details: { error: "unsupported_compositor" },
					};
				}
				const res = await runCmd("hyprctl", ["dispatch", "workspace", params.workspace]);
				if (res.code !== 0) {
					return {
						content: [{ type: "text", text: `Failed to switch workspace: ${res.stderr}` }],
						details: { error: res.stderr },
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
				if (isHyprland()) {
					await runCmd("hyprctl", ["dispatch", "exec", params.command]);
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
				if (isHyprland()) {
					const res = await runCmd("hyprctl", ["cursorpos", "-j"]);
					if (res.code === 0) {
						try {
							const pos = JSON.parse(res.stdout) as { x: number; y: number };
							return {
								content: [{ type: "text", text: `Cursor position: X=${pos.x}, Y=${pos.y}` }],
								details: pos,
							};
						} catch {}
					}
				}
				return {
					content: [{ type: "text", text: "Could not retrieve cursor position." }],
					details: { error: "unsupported" },
				};
			}

			case "screenshot": {
				const target = params.target ?? "active_window";
				const timestamp = Date.now();
				const tmpRaw = path.join(os.tmpdir(), `aerys-shot-${timestamp}-raw.png`);
				const tmpScaled = path.join(os.tmpdir(), `aerys-shot-${timestamp}.png`);

				let geometry: string | undefined;
				let targetWindow: DesktopWindowInfo | undefined;

				if (isHyprland()) {
					if (target === "active_window") {
						targetWindow = await getHyprlandActiveWindow();
						if (targetWindow && targetWindow.size[0] > 0 && targetWindow.size[1] > 0) {
							geometry = `${targetWindow.at[0]},${targetWindow.at[1]} ${targetWindow.size[0]}x${targetWindow.size[1]}`;
						}
					} else if (target !== "fullscreen") {
						const windows = await getHyprlandWindows();
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

				// Capture using grim on Wayland
				const captureArgs: string[] = [];
				if (geometry) {
					captureArgs.push("-g", geometry);
				}
				captureArgs.push(tmpRaw);

				const capRes = await runCmd("grim", captureArgs);
				if (capRes.code !== 0) {
					return {
						content: [{ type: "text", text: `Failed to capture screenshot with grim: ${capRes.stderr}` }],
						details: { error: capRes.stderr },
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
				if (isHyprland()) {
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

				const targetDesc = targetWindow
					? `window "${targetWindow.title}" (${targetWindow.class}) [${targetWindow.size[0]}x${targetWindow.size[1]}]`
					: geometry
						? `geometry ${geometry}`
						: "fullscreen display";

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
				};

				return {
					content: [
						{
							type: "text",
							text: `Captured screenshot of ${targetDesc} (saved to ${finalPath}).${frameNote}`,
						},
						...(base64
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
				const includeBase64 = params.includeBase64 ?? true;
				const timestamp = Date.now();
				const tmpRaw = path.join(os.tmpdir(), `aerys-eye-${timestamp}-raw.png`);
				const tmpFinal = path.join(os.tmpdir(), `aerys-eye-${timestamp}.png`);

				// Resolve what to look at: explicit region > window target > active window.
				let geometry: string | undefined;
				let targetWindow: DesktopWindowInfo | undefined;
				let targetDesc: string;
				if (params.region) {
					geometry = buildEyeGeometry(params.region, undefined);
					targetDesc = `region ${geometry}`;
				} else {
					const target = params.target ?? "active_window";
					if (isHyprland()) {
						if (target === "active_window") {
							targetWindow = await getHyprlandActiveWindow();
						} else if (target !== "fullscreen") {
							const windows = await getHyprlandWindows();
							const q = target.toLowerCase();
							targetWindow =
								windows.find(w => w.address.toLowerCase() === q) ||
								windows.find(w => w.class.toLowerCase().includes(q)) ||
								windows.find(w => w.title.toLowerCase().includes(q));
						}
						geometry = buildEyeGeometry(undefined, targetWindow);
					}
					targetDesc = describeEyeTarget(targetWindow, geometry, target);
				}

				// Ephemeral sweep: drop previous eye images from history BEFORE capturing
				// the new one (best-effort; tolerated if the host lacks the hook).
				let swept = 0;
				try {
					swept = (await this.session?.dropLiveEyeImages?.()) ?? 0;
				} catch {}

				const capRes = await runCmd("grim", geometry ? ["-g", geometry, tmpRaw] : [tmpRaw]);
				if (capRes.code !== 0) {
					return {
						content: [{ type: "text", text: `live_eye capture failed: ${capRes.stderr}` }],
						details: { error: capRes.stderr, swept },
					};
				}

				const maxWidth = params.maxWidth ?? 1280;
				const maxHeight = params.maxHeight ?? 800;
				let finalPath = tmpRaw;
				const resizeRes = await runCmd("convert", [tmpRaw, "-resize", `${maxWidth}x${maxHeight}>`, tmpFinal]);
				if (resizeRes.code === 0 && fs.existsSync(tmpFinal)) {
					finalPath = tmpFinal;
				}

				let base64 = "";
				if (includeBase64) {
					try {
						base64 = (await fs.promises.readFile(finalPath)).toString("base64");
					} catch {}
				}

				// OCR text extraction (opt-in): lets a visionless model read the frame.
				// Adaptive: run tesseract at native size first (fast path ~1s); only
				// pay for a 2x upscale + retry when the first pass comes back sparse
				// (<20 chars), which is how small-text frames fail.
				let ocrText = "";
				let ocrError: string | undefined;
				let ocrMs0 = 0;
				let ocrMode: "native" | "upscaled" | undefined;
				if (params.ocr) {
					ocrMs0 = Date.now();
					const ocr = await ocrFrame(finalPath, { lang: params.ocrLang });
					ocrText = ocr.text;
					ocrError = ocr.error;
					ocrMode = ocr.mode;
				}

				const parts: string[] = [
					`Eye view of ${targetDesc} (ephemeral — replaced next glance;${swept > 0 ? ` swept ${swept} older eye image(s)` : " no older eye images in context"}).`,
				];
				if (ocrText) {
					parts.push(
						`On-screen text (${ocrText.length} chars, tesseract ${ocrMode ?? "native"}):`,
						ocrText.length > 8000 ? `${ocrText.slice(0, 8000)}\n…[truncated]` : ocrText,
					);
				} else if (params.ocr && ocrError) {
					parts.push(`OCR failed: ${ocrError}`);
				} else if (params.ocr) {
					parts.push("OCR produced no text (frame may contain no readable text).");
				}

				return {
					content: [
						{ type: "text", text: parts.join("\n") },
						...(base64 ? [{ type: "image" as const, data: base64, mimeType: "image/png" }] : []),
					],
					details: {
						action: "live_eye",
						liveEye: { at: timestamp },
						filePath: finalPath,
						targetDesc,
						swept,
						...(params.ocr
							? { ocrText, ocrMode, ocrMs: Date.now() - ocrMs0, ...(ocrError ? { ocrError } : {}) }
							: {}),
					} as unknown as Record<string, unknown>,
				};
			}
		}
	}
}
