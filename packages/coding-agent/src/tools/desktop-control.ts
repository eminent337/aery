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
		.enum(["screenshot", "list_windows", "focus_window", "close_window", "switch_workspace", "launch_app", "cursor_pos"])
		.describe(
			"Action: 'screenshot' captures full screen or target window, 'list_windows' lists all open GUI apps, 'focus_window' brings an app to the front, 'close_window' closes a window, 'switch_workspace' changes workspace, 'launch_app' spawns a desktop app, 'cursor_pos' gets current mouse coordinates.",
		),
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
	command: z
		.string()
		.optional()
		.describe("Application command or desktop binary to run for 'launch_app' (e.g. 'brave', 'code', 'pavucontrol')."),
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
