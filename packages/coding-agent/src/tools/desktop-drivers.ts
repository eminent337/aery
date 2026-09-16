/**
 * Cross-platform desktop drivers (ferment D001: same live_* verbs on every OS).
 *
 * The driver interface owns everything OS/compositor-specific: session
 * detection, window control, screen capture, and which input backends exist.
 * Everything above the interface — hidden verify steers, backend fallback
 * chains, preAuthorize, frame math — stays driver-agnostic.
 *
 * Driver order: (1) Hyprland (native session, current box); (2) X11 (pure
 * X11 session OR XWayland fallback inside a Wayland session — the Xvfb
 * sandbox path already proves xdotool works here); (3) macOS / Windows
 * stubs report honest capability gaps until implemented.
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export type PlatformId = "hyprland" | "x11" | "macos" | "windows" | "unknown";

/** Minimal window shape the driver surface passes around. */
export interface DesktopWindowQuery {
	address: string;
	title: string;
	class: string;
	workspace: number | string;
	at: [number, number];
	size: [number, number];
	focused: boolean;
	pid?: number;
	/** True when the client is an XWayland/X11 app (input backend choice). */
	xwayland?: boolean;
}

export interface WindowControl {
	listWindows(): Promise<DesktopWindowQuery[]>;
	activeWindow(): Promise<DesktopWindowQuery | undefined>;
	focusWindow(address: string): Promise<string | null>;
	closeWindow(address: string): Promise<string | null>;
	switchWorkspace(workspace: string): Promise<string | null>;
}
/** Screen-capture + pointer-position surface. Geometry is the grim-style
 * "X,Y WxH" crop string the tool already builds (undefined = fullscreen). */
export interface CaptureControl {
	capture(tmpPath: string, geometry?: string): Promise<{ code: number; stderr: string }>;
	cursorPos(): Promise<{ x: number; y: number } | null>;
}
export interface DesktopDriver {
	readonly id: PlatformId;
	/** Human one-liner for live_backend_probe ("Hyprland 0.4x (Wayland)"). */
	readonly label: string;
	readonly windows: WindowControl;
	readonly capture: CaptureControl;
	/** Shell out inside the driver (DISPLAY etc. handled per-driver). */
	run(cmd: string, args: string[], opts?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** --- Output scale (physical px → logical units) ----------------------- */

/**
 * Wayland compositors take pointer positions in LOGICAL units, while grim
 * captures PHYSICAL pixels — on a scale≠1 monitor these diverge by the
 * monitor's scale factor (waywarp-scanner's core lesson). Auto-detect the
 * active scale: hyprctl → swaymsg → wlr-randr, falling back to 1 (indistinguishable
 * from a genuinely unscaled screen, which is the common case). Result is
 * cached briefly: scale changes mid-session are rare and re-querying per
 * pointer action would add a subprocess to every click.
 */
let scaleCache: { value: number; at: number } | null = null;
const SCALE_CACHE_MS = 30_000;

export async function detectOutputScale(): Promise<number> {
	if (scaleCache && Date.now() - scaleCache.at < SCALE_CACHE_MS) return scaleCache.value;
	// 1. Hyprland: monitors -j → [ {scale: 1.5, ...} ]
	try {
		const res = await runCmd("hyprctl", ["monitors", "-j"], { timeout: 4000 });
		if (res.code === 0) {
			const monitors = JSON.parse(res.stdout) as Array<{ scale?: number }>;
			const scale = monitors.find(m => typeof m.scale === "number" && m.scale > 0)?.scale;
			if (scale) {
				scaleCache = { value: scale, at: Date.now() };
				return scale;
			}
		}
	} catch {
		// fall through
	}
	// 2. sway: swaymsg -t get_outputs → [ {scale: 1.25, ...} ]
	try {
		const res = await runCmd("swaymsg", ["-t", "get_outputs"], { timeout: 4000 });
		if (res.code === 0) {
			const outputs = JSON.parse(res.stdout) as Array<{ scale?: number }>;
			const scale = outputs.find(o => typeof o.scale === "number" && o.scale > 0)?.scale;
			if (scale) {
				scaleCache = { value: scale, at: Date.now() };
				return scale;
		}
		}
	} catch {
		// fall through
	}
	// 3. wlr-randr (parse "Scale: 1.25" style lines). Last — its output shape
	// varies by compositor.
	try {
		const res = await runCmd("wlr-randr", [], { timeout: 4000 });
		if (res.code === 0) {
			const m = /Scale:\s*([0-9.]+)/.exec(res.stdout);
			const scale = m ? Number(m[1]) : 0;
			if (scale > 0) {
				scaleCache = { value: scale, at: Date.now() };
				return scale;
			}
		}
	} catch {
		// fall through
	}
	scaleCache = { value: 1, at: Date.now() };
	return 1;
}

/** Physical compositor pixels → logical pointer units (the space
 * `hyprctl movecursor`/`cursorpos` and ydotool's mapped absolute moves use). */
export function physicalToLogical(x: number, y: number, scale: number): { x: number; y: number } {
	if (!(scale > 0)) return { x, y };
	return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

/** Monitor reserved zones (waybar/pannels) in physical px. Layer-shell surfaces
 * are positioned inside the USABLE area, so an overlay must subtract these or
 * it lands offset by the bar height. Detects via hyprctl; zeros when unknown. */
let reservedCache: { value: { left: number; top: number; right: number; bottom: number }; at: number } | null = null;
const RESERVED_CACHE_MS = 30_000;
export async function detectReservedArea(): Promise<{ left: number; top: number; right: number; bottom: number }> {
	const zero = { left: 0, top: 0, right: 0, bottom: 0 };
	if (reservedCache && Date.now() - reservedCache.at < RESERVED_CACHE_MS) return reservedCache.value;
	try {
		const res = await runCmd("hyprctl", ["monitors", "-j"], { timeout: 4000 });
		if (res.code === 0) {
			const monitors = JSON.parse(res.stdout) as Array<{ reserved?: number[]; focused?: boolean }>;
			const mon = monitors.find(m => m.focused) ?? monitors[0];
			const r = mon?.reserved;
			if (Array.isArray(r) && r.length === 4) {
				const value = { left: r[0], top: r[1], right: r[2], bottom: r[3] };
				reservedCache = { value, at: Date.now() };
				return value;
			}
		}
	} catch {
		// fall through
	}
	reservedCache = { value: zero, at: Date.now() };
	return zero;
}

/** Test hook: clear the cached reserved zones so probes re-detect. */
export function clearReservedCache(): void {
	reservedCache = null;
}

/** Test hook: clear the cached scale so probes re-detect. */
export function clearScaleCache(): void {
	scaleCache = null;
}

/** Detect which driver owns this box. Pure env/platform check — no I/O. */
export function detectPlatformId(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PlatformId {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	if (env.HYPRLAND_INSTANCE_SIGNATURE) return "hyprland";
	const sessionType = (env.XDG_SESSION_TYPE || "").toLowerCase();
	if (sessionType === "x11") return "x11";
	if (env.DISPLAY && !env.WAYLAND_DISPLAY) return "x11";
	// Wayland-non-Hyprland (sway/river/…) or headless: xdotool still reaches
	// XWayland clients, so report x11 as the working subset.
	if (env.WAYLAND_DISPLAY || env.DISPLAY) return "x11";
	return "unknown";
}

async function runCmd(cmd: string, args: string[], opts?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const res = await execFileAsync(cmd, args, {
			timeout: opts?.timeout ?? 15000,
			env: { ...process.env, ...opts?.env },
		});
		return { code: 0, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
	} catch (e) {
		const err = e as { code?: number; stdout?: unknown; stderr?: unknown; message?: string };
		return {
			code: typeof err.code === "number" ? err.code : 1,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? err.message ?? "command failed"),
		};
	}
}

function parseHyprClients(stdout: string): DesktopWindowQuery[] {
	try {
		const raw = JSON.parse(stdout) as Array<{
			address: string; title: string; class: string;
			workspace?: { id: number; name: string };
			at: [number, number]; size: [number, number];
			focusHistoryID: number; xwayland?: boolean; pid?: number;
		}>;
		return raw.map(w => ({
			address: w.address, title: w.title || "(untitled)", class: w.class || "(unknown)",
			workspace: w.workspace?.name || w.workspace?.id || 1,
			at: w.at || [0, 0], size: w.size || [0, 0],
			focused: w.focusHistoryID === 0, pid: w.pid, xwayland: w.xwayland === true,
		}));
	} catch {
		return [];
	}
}

function parseHyprActive(stdout: string): DesktopWindowQuery | undefined {
	try {
		const w = JSON.parse(stdout);
		if (!w || !w.address) return undefined;
		return {
			address: w.address, title: w.title || "(untitled)", class: w.class || "(unknown)",
			workspace: w.workspace?.name || w.workspace?.id || 1,
			at: w.at || [0, 0], size: w.size || [0, 0],
			focused: true, pid: w.pid, xwayland: w.xwayland === true,
		};
	} catch {
		return undefined;
	}
}

/** Window title/class listing for pure-X11 via xdotool (no geometry — XQueryTree is out of scope). */
async function xdotoolWindows(displayEnv?: NodeJS.ProcessEnv): Promise<DesktopWindowQuery[]> {
	const res = await runCmd("xdotool", ["search", "--onlyvisible", "--name", ".", "getwindowname", "%@"], { env: displayEnv });
	if (res.code !== 0) return [];
	return res.stdout.split("\n").map(s => s.trim()).filter(Boolean).map((title, i) => ({
		address: `x11:${i}`, title: title || "(untitled)", class: "(unknown)",
		workspace: 1, at: [0, 0] as [number, number], size: [0, 0] as [number, number],
		focused: false, xwayland: true,
	}));
}

const hyprlandDriver: DesktopDriver = {
	id: "hyprland",
	label: "Hyprland (Wayland native)",
	windows: {
		async listWindows() {
			const res = await runCmd("hyprctl", ["clients", "-j"]);
			return res.code === 0 ? parseHyprClients(res.stdout) : [];
		},
		async activeWindow() {
			const res = await runCmd("hyprctl", ["activewindow", "-j"]);
			return res.code === 0 ? parseHyprActive(res.stdout) : undefined;
		},
		async focusWindow(address: string) {
			const res = await runCmd("hyprctl", ["dispatch", "focuswindow", `address:${address}`]);
			return res.code === 0 ? null : `hyprctl focuswindow failed: ${res.stderr}`;
		},
		async closeWindow(address: string) {
			const res = await runCmd("hyprctl", ["dispatch", "closewindow", `address:${address}`]);
			return res.code === 0 ? null : `hyprctl closewindow failed: ${res.stderr}`;
		},
		async switchWorkspace(workspace: string) {
			const res = await runCmd("hyprctl", ["dispatch", "workspace", workspace]);
			return res.code === 0 ? null : `hyprctl workspace failed: ${res.stderr}`;
		},
	},
	capture: {
		async capture(tmpPath: string, geometry?: string) {
			const args = geometry ? ["-g", geometry, tmpPath] : [tmpPath];
			// Short timeout: a locked/wedged compositor must fail fast so
			// settle() degrades instead of hanging the drive loop.
			const res = await runCmd("grim", args, { timeout: 4000 });
			return { code: res.code, stderr: res.stderr };
		},
		async cursorPos() {
			const res = await runCmd("hyprctl", ["cursorpos", "-j"]);
			if (res.code !== 0) return null;
			try {
				const pos = JSON.parse(res.stdout) as { x: number; y: number };
				return Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : null;
			} catch {
				return null;
			}
		},
	},
	run: runCmd,
};

const x11Driver: DesktopDriver = {
	id: "x11",
	label: "X11 (xdotool)",
	windows: {
		listWindows: () => xdotoolWindows(),
		async activeWindow() {
			const res = await runCmd("xdotool", ["getactivewindow", "getwindowname"]);
			if (res.code !== 0) return undefined;
			return {
				address: "x11:active", title: res.stdout.trim() || "(untitled)", class: "(unknown)",
				workspace: 1, at: [0, 0] as [number, number], size: [0, 0] as [number, number],
				focused: true, xwayland: true,
			};
		},
		async focusWindow(address: string) {
			const id = address.startsWith("x11:") ? address.slice(4) : address;
			const res = await runCmd("xdotool", ["windowactivate", id]);
			return res.code === 0 ? null : `xdotool windowactivate failed: ${res.stderr}`;
		},
		async closeWindow(address: string) {
			const id = address.startsWith("x11:") ? address.slice(4) : address;
			const res = await runCmd("xdotool", ["windowclose", id]);
			return res.code === 0 ? null : `xdotool windowclose failed: ${res.stderr}`;
		},
		async switchWorkspace(workspace: string) {
			const res = await runCmd("xdotool", ["set_desktop", workspace]);
			return res.code === 0 ? null : `xdotool set_desktop failed: ${res.stderr}`;
		},
	},
	capture: {
		async capture(tmpPath: string, geometry?: string) {
			// scrot lacks region crops; use ImageMagick import for both paths.
			const res = geometry
				? await runCmd("import", ["-window", "root", "-crop", geometry, tmpPath])
				: await runCmd("import", ["-window", "root", tmpPath]);
			if (res.code === 0) return { code: 0, stderr: "" };
			const fb = await runCmd("scrot", ["-z", tmpPath]);
			return { code: fb.code, stderr: fb.stderr };
		},
		async cursorPos() {
			const res = await runCmd("xdotool", ["getmouselocation", "--shell"]);
			if (res.code !== 0) return null;
			const x = /X=(-?\d+)/.exec(res.stdout);
			const y = /Y=(-?\d+)/.exec(res.stdout);
			return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
		},
	},
	run: runCmd,
};

/** Capability-gap stub: honest errors until a real driver lands. */
function unimplementedDriver(id: PlatformId, label: string, hint: string): DesktopDriver {
	const err = async (): Promise<never> => {
		throw new Error(`${label} driver not implemented yet — ${hint}`);
	};
	return {
		id,
		label,
		windows: {
			listWindows: () => err(),
			activeWindow: () => err(),
			focusWindow: () => err(),
			closeWindow: () => err(),
			switchWorkspace: () => err(),
		},
		capture: {
			capture: () => err(),
			cursorPos: () => err(),
		},
		run: () => err(),
	};
}

/** Resolve the driver for this box. Hyprland wins when present; X11 covers
 * pure-X11 sessions and the XWayland subset elsewhere; macOS/Windows report
 * their gap honestly. */
export function detectPlatformDriver(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): DesktopDriver {
	switch (detectPlatformId(env, platform)) {
		case "hyprland":
			return hyprlandDriver;
		case "x11":
			return x11Driver;
		case "macos":
			return unimplementedDriver("macos", "macOS (screencapture/CGEvent)", "needs screencapture + CGEvent injection driver");
		case "windows":
			return unimplementedDriver("windows", "Windows (Win32)", "needs Win32 capture + SendInput driver");
		default:
			return x11Driver;
	}
}
