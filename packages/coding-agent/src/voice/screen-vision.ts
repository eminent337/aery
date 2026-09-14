/**
 * Aerys "Live Eye" Screen Vision (on-demand capture).
 *
 * The agent looks when it wants to (like a human): a sub-second capture of the
 * user's active window or display. Nothing here is auto-attached to prompts —
 * the session-wide ambient buffer was removed; perception is a deliberate
 * glance via desktop_control live_eye / camera_control.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@aryee337/aery-ai";
import { logger, Snowflake } from "@aryee337/aery-utils";

export interface ActiveWindowInfo {
	title?: string;
	class?: string;
	at?: [number, number];
	size?: [number, number];
	workspace?: number | string;
}

export interface ScreenVisionResult {
	image?: ImageContent;
	metadata?: string;
	window?: ActiveWindowInfo;
	latencyMs: number;
	/** Path of the retained capture file when `keepFile` was requested (for OCR). */
	filePath?: string;
}
export interface CaptureOptions {
	target?: "active_window" | "fullscreen";
	quality?: number; // JPEG quality (1-100, default: 75)
	timeoutMs?: number; // Capture timeout (default: 800ms)
	/** Keep the temp capture file on disk (returned as `filePath`) so callers can OCR it. */
	keepFile?: boolean;
}

/** Helper to run a command with strict timeout and stdout capture */
function execAsync(
	cmd: string,
	args: string[],
	timeoutMs = 1000,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise(resolve => {
		try {
			const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let resolved = false;

			const timer = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					try {
						proc.kill("SIGKILL");
					} catch {}
					resolve({ stdout: "", stderr: "timeout", code: 1 });
				}
			}, timeoutMs);

			proc.stdout?.on("data", d => (stdout += d.toString()));
			proc.stderr?.on("data", d => (stderr += d.toString()));

			proc.on("close", code => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timer);
					resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 });
				}
			});

			proc.on("error", err => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timer);
					resolve({ stdout: "", stderr: err.message, code: 1 });
				}
			});
		} catch (err: unknown) {
			resolve({ stdout: "", stderr: String(err), code: 1 });
		}
	});
}

/** Normalize a window title: collapse whitespace, strip the Aery TUI self-title
 * echo (e.g. `kitty — "Aery: [Screen Vision: ...] ·"` or `kitty — "Aery: ..."`)
 * so capture metadata never contains a previous capture's metadata. */
function normalizeWindowTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	let t = title.replace(/\s+/g, " ").trim();
	// Drop the "Aery:" TUI marker plus anything trailing after it — the harness
	// status line and any embedded previous-capture metadata are never useful
	// screen context and create a feedback loop if kept.
	const selfIdx = t.indexOf("Aery:");
	if (selfIdx >= 0) t = t.slice(0, selfIdx).trim();
	return t.length > 0 ? t : undefined;
}

/** Get active window information using Hyprland IPC or xdotool fallback */
export async function getActiveWindow(): Promise<ActiveWindowInfo | null> {
	// 1. Wayland / Hyprland native check
	if (process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes("hyprland")) {
		const res = await execAsync("hyprctl", ["activewindow", "-j"], 400);
		if (res.code === 0 && res.stdout) {
			try {
				const data = JSON.parse(res.stdout);
				if (data && (data.title || data.class)) {
					return {
						title: normalizeWindowTitle(data.title),
						class: data.class,
						at: Array.isArray(data.at) ? [data.at[0], data.at[1]] : undefined,
						size: Array.isArray(data.size) ? [data.size[0], data.size[1]] : undefined,
						workspace: data.workspace?.id ?? data.workspace?.name,
					};
				}
			} catch {}
		}
	}

	// 2. X11 / xdotool fallback
	if (process.env.DISPLAY) {
		const res = await execAsync("xdotool", ["getactivewindow", "getwindowname"], 300);
		if (res.code === 0 && res.stdout) {
			return { title: normalizeWindowTitle(res.stdout) };
		}
	}

	return null;
}

/**
 * Captures an instantaneous screen or active-window frame as a compressed JPEG ImageContent.
 * Operates in ~150-200ms on Wayland via grim.
 */
export async function captureScreenFrame(options: CaptureOptions = {}): Promise<ScreenVisionResult> {
	const t0 = Date.now();
	const target = options.target ?? "active_window";
	const quality = options.quality ?? 75;
	const timeoutMs = options.timeoutMs ?? 800;

	const id = Snowflake.next();
	const tmpPath = path.join(os.tmpdir(), `aerys-vision-${id}.jpg`);

	let windowInfo: ActiveWindowInfo | null = null;
	let geometry: string | undefined;

	// Query active window if requested (fullscreen captures intentionally
	// skip this: grim's -g geometry path on fullscreen regions can hang on
	// this compositor, and a crop adds nothing for a full display grab).
	if (target === "active_window") {
		windowInfo = await getActiveWindow();
		if (windowInfo?.at && windowInfo?.size && windowInfo.size[0] > 0 && windowInfo.size[1] > 0) {
			geometry = `${windowInfo.at[0]},${windowInfo.at[1]} ${windowInfo.size[0]}x${windowInfo.size[1]}`;
		}
	}

	let captured = false;

	// 1. Wayland grim capture (ultra-fast ~180ms)
	if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
		const grimArgs: string[] = [];
		if (geometry) {
			grimArgs.push("-g", geometry);
		}
		grimArgs.push("-t", "jpeg", "-q", String(quality), tmpPath);
		const res = await execAsync("grim", grimArgs, timeoutMs);
		captured = res.code === 0;
	}

	// 2. X11 fallback (scrot or import)
	if (!captured && process.env.DISPLAY) {
		if (geometry) {
			const res = await execAsync(
				"import",
				["-window", "root", "-crop", geometry.replace(" ", "+"), tmpPath],
				timeoutMs,
			);
			captured = res.code === 0;
		} else {
			const res = await execAsync("scrot", ["-z", "-q", String(quality), tmpPath], timeoutMs);
			captured = res.code === 0;
		}
	}

	// 3. macOS fallback
	if (!captured && process.platform === "darwin") {
		const res = await execAsync("screencapture", ["-x", "-t", "jpg", tmpPath], timeoutMs);
		captured = res.code === 0;
	}

	const latencyMs = Date.now() - t0;

	if (!captured) {
		return { latencyMs };
	}

	try {
		const keep = options.keepFile === true;
		const buf = await fs.readFile(tmpPath);
		if (!keep) await fs.rm(tmpPath, { force: true });
		const image: ImageContent = {
			type: "image",
			data: buf.toString("base64"),
			mimeType: "image/jpeg",
		};

		// Metadata text is intentionally disabled: Peter asked for the
		// "[Screen Vision: …]" / "[Active Window: …]" label to never display.
		// The JPEG itself is the grounding (documented in the system prompt);
		// drop-in reversal: restore the block below to re-enable the text.
		let metadata: string | undefined;
		// if (windowInfo?.title || windowInfo?.class) {
		// 	const app = windowInfo.class || "Application";
		// 	const title = windowInfo.title || "Untitled";
		// 	metadata = `[Active Window: ${app} — "${title}"]`;
		// } else {
		// 	metadata = "[Screen Vision: Full Display Snapshot]";
		// }

		logger.debug("Screen vision snapshot captured", {
			latencyMs,
			sizeKb: Math.round(buf.length / 1024),
			target,
			metadata,
		});

		return {
			image,
			metadata,
			window: windowInfo ?? undefined,
			latencyMs,
			...(keep ? { filePath: tmpPath } : {}),
		};
	} catch {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
		return { latencyMs };
	}
}
