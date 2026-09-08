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
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";

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
			"focus_window",
			"close_window",
			"switch_workspace",
			"launch_app",
			"cursor_pos",
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
			"Actions: 'screenshot' captures display/window, 'list_windows' lists open GUI apps, 'focus_window' brings app to front, 'close_window' closes a window, 'switch_workspace' changes workspace, 'launch_app' spawns a VISIBLE app on the desktop, 'cursor_pos' gets mouse coordinates, 'system_control' controls volume/media/brightness/lock/web search. Headless (invisible virtual display): 'xvfb_launch' runs a desktop app invisibly, 'xvfb_screenshot' captures its UI, 'xvfb_list_windows' lists windows on the virtual display, 'xvfb_click'/'xvfb_type'/'xvfb_key' drive the app, 'xvfb_close' ends it all.",
		),
	command: z
		.string()
		.optional()
		.describe("Application command or desktop binary to run for 'launch_app' or 'xvfb_launch' (e.g. 'brave', 'code', 'pavucontrol'). For 'xvfb_launch' you may append args and a URL (e.g. 'flatpak run com.brave.Browser https://example.com')."),
	url: z.string().optional().describe("URL to open with the app for 'xvfb_launch' (appended to command)."),
	x: z.number().int().optional().describe("X pixel coordinate for 'xvfb_click' (virtual display origin top-left)."),
	y: z.number().int().optional().describe("Y pixel coordinate for 'xvfb_click'."),
	keys: z.string().optional().describe("Keys or text for 'xvfb_type' (literal text) or 'xvfb_key' (key names like Return, Tab, ctrl+l, space)."),
	target: z
		.string()
		.optional()
		.describe(
			"Target for 'screenshot' ('fullscreen', 'active_window', or substring of window title/class). Default: 'active_window'.",
		),
	query: z
		.string()
		.optional()
		.describe("Window address, title, or class query for 'focus_window' or 'close_window'."),
	workspace: z
		.string()
		.optional()
		.describe("Workspace identifier for 'switch_workspace' (e.g. '1', '2', 'special')."),
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
	maxWidth: z
		.number()
		.int()
		.optional()
		.describe("Max pixel width for vision downscaling (default: 1280)."),
	maxHeight: z
		.number()
		.int()
		.optional()
		.describe("Max pixel height for vision downscaling (default: 800)."),
	includeBase64: z
		.boolean()
		.optional()
		.describe("Whether to return base64 encoded image in result for inline model vision (default: true)."),
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
	const up = await runCmd("sh", ["-c", `nohup Xvfb ${XVFB_DISPLAY} -screen 0 ${XVFB_GEOMETRY} >/dev/null 2>&1 & sleep 1.5`]);
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
		? res.stdout.split("\n").map(s => s.trim()).filter(Boolean)
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
		};
	} catch {
		return undefined;
	}
}

export class DesktopControlTool implements AgentTool<typeof desktopControlSchema> {
	readonly name = "desktop_control";
	readonly approval = "read" as const;
	readonly label = "Desktop Control";
	readonly description =
		"Desktop screen vision and window manager tool. Takes full-screen or window-targeted screenshots with DPI scaling, lists open windows, focuses or closes applications, and manages workspaces.";
	readonly parameters = desktopControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Desktop vision and window control (screenshots, window listing/focus/close, workspaces)";

	static createIf(_session: ToolSession): DesktopControlTool | null {
		return new DesktopControlTool();
	}

	async execute(_id: string, params: DesktopControlParams): Promise<AgentToolResult> {
		switch (params.action) {
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
						content: [{ type: "text", text: "Error: 'query' (window title, class, or address) is required for focus_window." }],
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
						content: [{ type: "text", text: "Error: 'query' (window title, class, or address) is required for close_window." }],
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
					const up = await runCmd("sh", ["-c", `nohup ${cmd} >/tmp/aerys-xvfb-app.log 2>&1 &`], {
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
						content: [{ type: "text", text: `xvfb_launch failed: ${String(err)}. Is xorg-server-xvfb installed?` }],
						details: { error: "xvfb_launch_failed" },
					};
				}
			}

			case "xvfb_screenshot": {
				try {
					await xvfbEnsureServer();
					const outPath = `/tmp/aerys-xvfb-shot-${Date.now()}.png`;
					const shot = await runCmd(
						"import",
						["-window", "root", outPath],
						{ env: xvfbEnv(), timeout: 15_000 },
					);
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
								? [{ type: "text" as const, text: "Note: capture looks empty (no windows on the virtual display?)." }]
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
					return { content: [{ type: "text", text: "Error: 'x' and 'y' pixel coordinates are required for xvfb_click (see the xvfb_screenshot image for where to click)." }] };
				}
				await xvfbEnsureServer();
				const btn = params.target && /right|middle/.test(params.target) ? params.target : "left";
				const res = await runCmd("xdotool", ["mousemove", String(params.x), String(params.y), "click", btn], {
					env: xvfbEnv(),
				});
				return res.code === 0
					? { content: [{ type: "text", text: `Clicked ${btn} at ${params.x},${params.y} on the headless display.` }] }
					: { content: [{ type: "text", text: `xvfb_click failed: ${res.stderr}` }] };
			}

			case "xvfb_type": {
				if (!params.keys) {
					return { content: [{ type: "text", text: "Error: 'keys' (the text to type) is required for xvfb_type." }] };
				}
				await xvfbEnsureServer();
				const res = await runCmd("xdotool", ["type", "--delay", "40", params.keys], { env: xvfbEnv() });
				return res.code === 0
					? { content: [{ type: "text", text: `Typed text into the focused headless window.` }] }
					: { content: [{ type: "text", text: `xvfb_type failed: ${res.stderr}` }] };
			}

			case "xvfb_key": {
				if (!params.keys) {
					return { content: [{ type: "text", text: "Error: 'keys' (key names like Return, Tab, ctrl+l) is required for xvfb_key." }] };
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
					content: [{ type: "text", text: `Headless session closed (${wins.length} window(s) closed, virtual display stopped).` }],
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
				const resizeRes = await runCmd("convert", [
					tmpRaw,
					"-resize",
					`${maxWidth}x${maxHeight}>`,
					tmpScaled,
				]);
				if (resizeRes.code === 0 && fs.existsSync(tmpScaled)) {
					finalPath = tmpScaled;
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
					target,
					targetWindow: targetWindow
						? { title: targetWindow.title, class: targetWindow.class, address: targetWindow.address }
						: undefined,
				};

				return {
					content: [
						{
							type: "text",
							text: `Captured screenshot of ${targetDesc} (saved to ${finalPath}).`,
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
		}
	}
}
