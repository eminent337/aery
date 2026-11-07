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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentDesktopBinary } from "./desktop-accessibility";
import { execFileNiced } from "./capture-priority";
import { hyprCommandSocketPath, hyprFastMoveCursor, hyprIpcDispatch as hyprIpcQuery } from "./live-input";

export { hyprCommandSocketPath, hyprFastMoveCursor, hyprIpcQuery };

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
	captureBuffer(geometry?: string): Promise<{ code: number; buffer?: Buffer; stderr: string }>;
	cursorPos(): Promise<{ x: number; y: number } | null>;
}
export interface AccessibilityControl {
	isAvailable(): Promise<boolean>;
	run(args: string[]): Promise<{ code: number; stdout: string; stderr: string; data?: any }>;
}

export interface DesktopDriver {
	readonly id: PlatformId;
	/** Human one-liner for live_backend_probe ("Hyprland 0.4x (Wayland)"). */
	readonly label: string;
	readonly windows: WindowControl;
	readonly capture: CaptureControl;
	readonly accessibility: AccessibilityControl;
	/** Shell out inside the driver (DISPLAY etc. handled per-driver). */
	run(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
	): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function createAccessibilityControl(): AccessibilityControl {
	return {
		async isAvailable(): Promise<boolean> {
			const bin = resolveAgentDesktopBinary();
			return bin !== null;
		},
		async run(args: string[]): Promise<{ code: number; stdout: string; stderr: string; data?: any }> {
			const bin = resolveAgentDesktopBinary();
			if (!bin) return { code: 127, stdout: "", stderr: "agent-desktop binary not found" };
			const res = await runCmd(bin, args, { timeout: 15000 });
			let data: any;
			try {
				data = JSON.parse(res.stdout);
			} catch {}
			return { ...res, data };
		},
	};
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
	// 1. Hyprland fast socket query or hyprctl: monitors -j → [ {scale: 1.5, ...} ]
	try {
		if (hyprCommandSocketPath()) {
			const out = await hyprIpcQuery("j/monitors");
			const monitors = JSON.parse(out) as Array<{ scale?: number }>;
			const scale = monitors.find(m => typeof m.scale === "number" && m.scale > 0)?.scale;
			if (scale) {
				scaleCache = { value: scale, at: Date.now() };
				return scale;
			}
		}
	} catch {
		// fall through
	}
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
		if (hyprCommandSocketPath()) {
			const out = await hyprIpcQuery("j/monitors");
			const monitors = JSON.parse(out) as Array<{ reserved?: number[]; focused?: boolean }>;
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
export function detectPlatformId(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): PlatformId {
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

async function runCmd(
	cmd: string,
	args: string[],
	opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const res = await execFileNiced(cmd, args, {
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

function parseHyprActive(stdout: string): DesktopWindowQuery | undefined {
	try {
		const w = JSON.parse(stdout);
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

/** Window title/class listing for pure-X11 via xdotool (no geometry — XQueryTree is out of scope). */
async function xdotoolWindows(displayEnv?: NodeJS.ProcessEnv): Promise<DesktopWindowQuery[]> {
	const res = await runCmd("xdotool", ["search", "--onlyvisible", "--name", ".", "getwindowname", "%@"], {
		env: displayEnv,
	});
	if (res.code !== 0) return [];
	return res.stdout
		.split("\n")
		.map(s => s.trim())
		.filter(Boolean)
		.map((title, i) => ({
			address: `x11:${i}`,
			title: title || "(untitled)",
			class: "(unknown)",
			workspace: 1,
			at: [0, 0] as [number, number],
			size: [0, 0] as [number, number],
			focused: false,
			xwayland: true,
		}));
}

const hyprlandDriver: DesktopDriver = {
	id: "hyprland",
	label: "Hyprland (Wayland native)",
	windows: {
		async listWindows() {
			try {
				if (hyprCommandSocketPath()) {
					const out = await hyprIpcQuery("j/clients");
					const clients = parseHyprClients(out);
					if (clients.length > 0) return clients;
				}
			} catch {
				// fallback to hyprctl spawn
			}
			const res = await runCmd("hyprctl", ["clients", "-j"]);
			return res.code === 0 ? parseHyprClients(res.stdout) : [];
		},
		async activeWindow() {
			try {
				if (hyprCommandSocketPath()) {
					const out = await hyprIpcQuery("j/activewindow");
					const parsed = parseHyprActive(out);
					if (parsed) return parsed;
				}
			} catch {
				// fallback
			}
			const res = await runCmd("hyprctl", ["activewindow", "-j"]);
			return res.code === 0 ? parseHyprActive(res.stdout) : undefined;
		},
		async focusWindow(address: string) {
			try {
				if (hyprCommandSocketPath()) {
					const reply = await hyprIpcQuery(`dispatch focuswindow address:${address}`);
					return reply.trim() === "ok" ? null : `hyprctl focuswindow failed: ${reply}`;
				}
			} catch {
				// fallback
			}
			const res = await runCmd("hyprctl", ["dispatch", "focuswindow", `address:${address}`]);
			return res.code === 0 ? null : `hyprctl focuswindow failed: ${res.stderr}`;
		},
		async closeWindow(address: string) {
			try {
				if (hyprCommandSocketPath()) {
					const reply = await hyprIpcQuery(`dispatch closewindow address:${address}`);
					return reply.trim() === "ok" ? null : `hyprctl closewindow failed: ${reply}`;
				}
			} catch {
				// fallback
			}
			const res = await runCmd("hyprctl", ["dispatch", "closewindow", `address:${address}`]);
			return res.code === 0 ? null : `hyprctl closewindow failed: ${res.stderr}`;
		},
		async switchWorkspace(workspace: string) {
			try {
				if (hyprCommandSocketPath()) {
					const reply = await hyprIpcQuery(`dispatch workspace ${workspace}`);
					return reply.trim() === "ok" ? null : `hyprctl workspace failed: ${reply}`;
				}
			} catch {
				// fallback
			}
			const res = await runCmd("hyprctl", ["dispatch", "workspace", workspace]);
			return res.code === 0 ? null : `hyprctl workspace failed: ${res.stderr}`;
		},
	},
	capture: {
		async capture(tmpPath: string, geometry?: string) {
			// -c paints the cursor into the frame: without it agents literally
			// cannot see where the pointer is (verified: with/without differ
			// by ~0.02 RMSE, cursor near-invisible in the downscaled frame).
			const args = geometry ? ["-c", "-g", geometry, tmpPath] : ["-c", tmpPath];
			// Short timeout: a locked/wedged compositor must fail fast so
			// settle() degrades instead of hanging the drive loop.
			const res = await runCmd("grim", args, { timeout: 4000 });
			return { code: res.code, stderr: res.stderr };
		},
		async captureBuffer(geometry?: string) {
			const args = geometry ? ["-t", "png", "-c", "-g", geometry, "-"] : ["-t", "png", "-c", "-"];
			return new Promise<{ code: number; buffer?: Buffer; stderr: string }>((resolve) => {
				const proc = spawn("grim", args, { stdio: ["ignore", "pipe", "pipe"] });
				const chunks: Buffer[] = [];
				let stderr = "";
				let settled = false;
				const timer = setTimeout(() => {
					if (!settled) {
						settled = true;
						try { proc.kill("SIGKILL"); } catch {}
						resolve({ code: 1, stderr: "grim captureBuffer timed out after 5000ms" });
					}
				}, 5000);
				proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
				proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
				proc.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (code === 0) {
						resolve({ code: 0, buffer: Buffer.concat(chunks), stderr: "" });
					} else {
						resolve({ code: code ?? 1, stderr });
					}
				});
				proc.on("error", (err) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({ code: 1, stderr: err.message });
				});
			});
		},
		async cursorPos() {
			try {
				if (hyprCommandSocketPath()) {
					const out = await hyprIpcQuery("j/cursorpos");
					const pos = JSON.parse(out) as { x: number; y: number };
					if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) return pos;
				}
			} catch {
				// fallback
			}
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
	accessibility: createAccessibilityControl(),
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
				address: "x11:active",
				title: res.stdout.trim() || "(untitled)",
				class: "(unknown)",
				workspace: 1,
				at: [0, 0] as [number, number],
				size: [0, 0] as [number, number],
				focused: true,
				xwayland: true,
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
		async captureBuffer(geometry?: string) {
			const args = geometry
				? ["-window", "root", "-crop", geometry, "png:-"]
				: ["-window", "root", "png:-"];
			return new Promise<{ code: number; buffer?: Buffer; stderr: string }>((resolve) => {
				const proc = spawn("import", args, { stdio: ["ignore", "pipe", "pipe"] });
				const chunks: Buffer[] = [];
				let stderr = "";
				proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
				proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
				proc.on("close", (code) => {
					if (code === 0) {
						resolve({ code: 0, buffer: Buffer.concat(chunks), stderr: "" });
					} else {
						resolve({ code: code ?? 1, stderr });
					}
				});
				proc.on("error", (err) => resolve({ code: 1, stderr: err.message }));
			});
		},
		async cursorPos() {
			const res = await runCmd("xdotool", ["getmouselocation", "--shell"]);
			if (res.code !== 0) return null;
			const x = /X=(-?\d+)/.exec(res.stdout);
			const y = /Y=(-?\d+)/.exec(res.stdout);
			return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
		},
	},
	accessibility: createAccessibilityControl(),
	run: runCmd,
};

const macosDriver: DesktopDriver = {
	id: "macos",
	label: "macOS (screencapture / osascript / cliclick)",
	windows: {
		async listWindows() {
			const script = `
tell application "System Events"
	set appList to every application process whose background only is false
	set out to ""
	repeat with a in appList
		set aName to name of a
		set aId to unix id of a
		set wList to windows of a
		repeat with w in wList
			set wName to name of w
			set wPos to position of w
			set wSize to size of w
			set out to out & aName & "|" & aId & "|" & wName & "|" & (item 1 of wPos) & "|" & (item 2 of wPos) & "|" & (item 1 of wSize) & "|" & (item 2 of wSize) & "\n"
		end repeat
	end repeat
	return out
end tell`;
			const res = await runCmd("osascript", ["-e", script], { timeout: 5000 });
			if (res.code !== 0) return [];
			const lines = res.stdout.trim().split("\n").filter(Boolean);
			const wins: DesktopWindowQuery[] = [];
			for (const line of lines) {
				const parts = line.split("|");
				if (parts.length >= 7) {
					wins.push({
						address: `macos:${parts[1] || parts[0]}`,
						class: parts[0] || "(unknown)",
						pid: Number(parts[1]) || undefined,
						title: parts[2] || "(untitled)",
						at: [Number(parts[3]) || 0, Number(parts[4]) || 0],
						size: [Number(parts[5]) || 0, Number(parts[6]) || 0],
						workspace: 1,
						focused: false,
						xwayland: false,
					});
				}
			}
			return wins;
		},
		async activeWindow() {
			const script = `
tell application "System Events"
	set p to first application process whose frontmost is true
	set pName to name of p
	set pId to unix id of p
	set wTitle to ""
	set wPos to {0, 0}
	set wSize to {0, 0}
	try
		set w to window 1 of p
		set wTitle to name of w
		set wPos to position of w
		set wSize to size of w
	end try
	return "{\\"title\\":\\"" & wTitle & "\\",\\"class\\":\\"" & pName & "\\",\\"pid\\":" & pId & ",\\"at\\":[" & (item 1 of wPos) & "," & (item 2 of wPos) & "],\\"size\\":[" & (item 1 of wSize) & "," & (item 2 of wSize) & "]}"
end tell`;
			const res = await runCmd("osascript", ["-e", script], { timeout: 5000 });
			if (res.code !== 0) return undefined;
			try {
				const data = JSON.parse(res.stdout);
				return {
					address: `macos:${data.pid || data.class}`,
					title: data.title || "(untitled)",
					class: data.class || "(unknown)",
					workspace: 1,
					at: Array.isArray(data.at) && data.at.length === 2 ? [data.at[0], data.at[1]] : [0, 0],
					size: Array.isArray(data.size) && data.size.length === 2 ? [data.size[0], data.size[1]] : [0, 0],
					focused: true,
					pid: data.pid,
					xwayland: false,
				};
			} catch {
				return undefined;
			}
		},
		async focusWindow(address: string) {
			const target = address.startsWith("macos:") ? address.slice(6) : address;
			const isPid = /^\d+$/.test(target);
			const script = isPid
				? `tell application "System Events" to set frontmost of (first application process whose unix id is ${target}) to true`
				: `tell application "${target}" to activate`;
			const res = await runCmd("osascript", ["-e", script], { timeout: 5000 });
			return res.code === 0 ? null : `macOS focus failed: ${res.stderr}`;
		},
		async closeWindow(address: string) {
			const target = address.startsWith("macos:") ? address.slice(6) : address;
			const isPid = /^\d+$/.test(target);
			const script = isPid
				? `tell application "System Events" to tell (first application process whose unix id is ${target}) to click (first button whose subrole is "AXCloseButton") of window 1`
				: `tell application "${target}" to close front window`;
			const res = await runCmd("osascript", ["-e", script], { timeout: 5000 });
			return res.code === 0 ? null : `macOS close failed: ${res.stderr}`;
		},
		async switchWorkspace(_workspace: string) {
			return null;
		},
	},
	capture: {
		async capture(tmpPath: string, geometry?: string) {
			const args = ["-x", "-C"];
			if (geometry) {
				const m = /^(-?\d+),(-?\d+)\s+(\d+)x(\d+)$/.exec(geometry.trim());
				if (m) {
					args.push("-R", `${m[1]},${m[2]},${m[3]},${m[4]}`);
				}
			}
			args.push(tmpPath);
			const res = await runCmd("screencapture", args, { timeout: 8000 });
			return { code: res.code, stderr: res.stderr };
		},
		async captureBuffer(geometry?: string) {
			const tmp = path.join(os.tmpdir(), `aery-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
			const res = await this.capture(tmp, geometry);
			if (res.code !== 0) return { code: res.code, stderr: res.stderr };
			try {
				const buf = await fs.promises.readFile(tmp);
				await fs.promises.unlink(tmp).catch(() => {});
				return { code: 0, buffer: buf, stderr: "" };
			} catch (e: any) {
				return { code: 1, stderr: e.message };
			}
		},
		async cursorPos() {
			const cliRes = await runCmd("cliclick", ["p"], { timeout: 1000 }).catch(() => null);
			if (cliRes && cliRes.code === 0) {
				const m = /^(\d+),(\d+)$/.exec(cliRes.stdout.trim());
				if (m) return { x: Number(m[1]), y: Number(m[2]) };
			}
			const jxaScript = `ObjC.import("CoreGraphics"); var loc = $.CGEventGetLocation($.CGEventCreate(null)); JSON.stringify({ x: Math.round(loc.x), y: Math.round(loc.y) });`;
			const res = await runCmd("osascript", ["-l", "JavaScript", "-e", jxaScript], { timeout: 2000 });
			if (res.code !== 0) return null;
			try {
				const pos = JSON.parse(res.stdout);
				return Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : null;
			} catch {
				return null;
			}
		},
	},
	accessibility: createAccessibilityControl(),
	run: runCmd,
};

const windowsDriver: DesktopDriver = {
	id: "windows",
	label: "Windows (Win32 / PowerShell)",
	windows: {
		async listWindows() {
			const cmd = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
			const res = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 5000 });
			if (res.code !== 0) return [];
			try {
				const raw = JSON.parse(res.stdout);
				const list = Array.isArray(raw) ? raw : [raw];
				return list.map((p: any) => ({
					address: `win32:${p.Id}`,
					title: p.MainWindowTitle || "(untitled)",
					class: p.ProcessName || "(unknown)",
					workspace: 1,
					at: [0, 0] as [number, number],
					size: [0, 0] as [number, number],
					focused: false,
					pid: p.Id,
					xwayland: false,
				}));
			} catch {
				return [];
			}
		},
		async activeWindow() {
			const cmd = `
$sig = @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
Add-Type -MemberDefinition $sig -Name Win32Utils -Namespace Win32API
$h = [Win32API.Win32Utils]::GetForegroundWindow()
if ($h -ne [IntPtr]::Zero) {
	$sb = New-Object System.Text.StringBuilder 256
	[void][Win32API.Win32Utils]::GetWindowText($h, $sb, 256)
	$pid = 0
	[void][Win32API.Win32Utils]::GetWindowThreadProcessId($h, [ref]$pid)
	$rc = New-Object Win32API.RECT
	[void][Win32API.Win32Utils]::GetWindowRect($h, [ref]$rc)
	$pName = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName
	@{ title = $sb.ToString(); class = $pName; pid = $pid; at = @($rc.Left, $rc.Top); size = @($rc.Right - $rc.Left, $rc.Bottom - $rc.Top) } | ConvertTo-Json -Compress
}`;
			const res = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 5000 });
			if (res.code !== 0) return undefined;
			try {
				const data = JSON.parse(res.stdout);
				return {
					address: `win32:${data.pid || data.class}`,
					title: data.title || "(untitled)",
					class: data.class || "(unknown)",
					workspace: 1,
					at: Array.isArray(data.at) && data.at.length === 2 ? [data.at[0], data.at[1]] : [0, 0],
					size: Array.isArray(data.size) && data.size.length === 2 ? [data.size[0], data.size[1]] : [0, 0],
					focused: true,
					pid: data.pid,
					xwayland: false,
				};
			} catch {
				return undefined;
			}
		},
		async focusWindow(address: string) {
			const target = address.startsWith("win32:") ? address.slice(6) : address;
			const cmd = `
$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
Add-Type -MemberDefinition $sig -Name Win32Focus -Namespace Win32API
$p = Get-Process -Id ${target} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
	[void][Win32API.Win32Focus]::SetForegroundWindow($p.MainWindowHandle)
}`;
			const res = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 5000 });
			return res.code === 0 ? null : `Windows focus failed: ${res.stderr}`;
		},
		async closeWindow(address: string) {
			const target = address.startsWith("win32:") ? address.slice(6) : address;
			const cmd = `Stop-Process -Id ${target} -ErrorAction SilentlyContinue`;
			const res = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 5000 });
			return res.code === 0 ? null : `Windows close failed: ${res.stderr}`;
		},
		async switchWorkspace(_workspace: string) {
			return null;
		},
	},
	capture: {
		async capture(tmpPath: string, _geometry?: string) {
			const escaped = tmpPath.replace(/'/g, "''");
			const cmd = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()`;
			const res = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 8000 });
			return { code: res.code, stderr: res.stderr };
		},
		async captureBuffer(geometry?: string) {
			const tmp = path.join(os.tmpdir(), `aery-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
			const res = await this.capture(tmp, geometry);
			if (res.code !== 0) return { code: res.code, stderr: res.stderr };
			try {
				const buf = await fs.promises.readFile(tmp);
				await fs.promises.unlink(tmp).catch(() => {});
				return { code: 0, buffer: buf, stderr: "" };
			} catch (e: any) {
				return { code: 1, stderr: e.message };
			}
		},
		async cursorPos() {
			const cmd = `
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
Write-Output ('{"x":' + $p.X + ',"y":' + $p.Y + '}')`;
			const res = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 3000 });
			if (res.code !== 0) return null;
			try {
				const pos = JSON.parse(res.stdout.trim());
				return Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : null;
			} catch {
				return null;
			}
		},
	},
	accessibility: createAccessibilityControl(),
	run: runCmd,
};

/** Resolve the driver for this box. Hyprland wins when present; X11 covers
 * pure-X11 sessions and the XWayland subset elsewhere; macOS covers Darwin;
 * Windows covers Win32. */
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
			return macosDriver;
		case "windows":
			return windowsDriver;
		default:
			return x11Driver;
	}
}
