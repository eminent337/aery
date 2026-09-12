/**
 * Aerys "Live Eye" Screen Vision & Ambient Context.
 *
 * Implements real-time screen grounding inspired by Google Project Astra,
 * Gemini Live, and Screenpipe. Captures lightweight JPEG snapshots of the
 * user's active window or display in ~180ms to provide visual situational
 * awareness during voice and interactive turns.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@aryee337/aery-ai";
import { logger, Snowflake } from "@aryee337/aery-utils";
import { ocrFrame } from "../tools/screen-ocr";

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

	// Query active window if requested
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

// ---------------------------------------------------------------------------
// Astra-style Ambient Screen Buffer
// ---------------------------------------------------------------------------
// Project Astra / Gemini Live keep a continuous low-fps visual memory so the
// assistant can see what the user was looking at BEFORE they finished speaking.
// Ported as a rolling JPEG ring buffer: a background loop captures a cheap
// downscaled frame every second into memory; at speech onset the turn attaches
// the frame from when the user BEGAN talking plus the freshest one. No video
// stream, no new dependencies — same grim/hyprctl stack as Live Eye.

interface AmbientFrame {
	/** Full-resolution base64 JPEG (for attachment to turns). */
	image: ImageContent;
	/** Capture timestamp (Date.now()). */
	at: number;
	/** Active window metadata at capture time. */
	window?: ActiveWindowInfo;
	/** Metadata line, e.g. [Active Window: kitty — "…"]. */
	metadata?: string;
}

const AMBIENT_MAX_FRAMES = 12; // ~12s of memory at 1fps
const AMBIENT_INTERVAL_MS = 1000;

const ambientFrames: AmbientFrame[] = [];
let ambientTimer: ReturnType<typeof setInterval> | undefined;
let ambientBusy = false;

/** Start the background 1fps ambient capture loop (idempotent). */
export function startAmbientScreenBuffer(): void {
	if (ambientTimer || process.env.WAYLAND_DISPLAY === undefined) return;
	ambientTimer = setInterval(() => {
		if (ambientBusy) return; // never stack captures
		ambientBusy = true;
		void captureScreenFrame({ target: "fullscreen", quality: 70, timeoutMs: 900 })
			.then(async vision => {
				if (vision.image) {
					ambientFrames.push({
						image: vision.image,
						at: Date.now(),
						window: vision.window,
						metadata: vision.metadata,
					});
					while (ambientFrames.length > AMBIENT_MAX_FRAMES) ambientFrames.shift();
				}
			})
			.finally(() => {
				ambientBusy = false;
			});
	}, AMBIENT_INTERVAL_MS);
}

/** Stop the ambient loop and drop buffered frames. */
export function stopAmbientScreenBuffer(): void {
	if (ambientTimer) {
		clearInterval(ambientTimer);
		ambientTimer = undefined;
	}
	ambientFrames.length = 0;
}

/** Test/diagnostic handle: whether the loop is running. */
export function isAmbientScreenBufferRunning(): boolean {
	return ambientTimer !== undefined;
}

/**
 * Astra-style retrieval: frames bracketing the user's utterance — the visual
 * context at speech onset plus the freshest frame at transcription. Falls back
 * to whatever the buffer holds. Returns [] when the buffer is empty.
 */
export function getAmbientFramesForTurn(speechStartedAt?: number): ImageContent[] {
	if (ambientFrames.length === 0) return [];
	const picked: AmbientFrame[] = [];
	if (speechStartedAt !== undefined) {
		// Frame at (or just before) speech onset
		let onset: AmbientFrame | undefined;
		for (const f of ambientFrames) {
			if (f.at <= speechStartedAt) onset = f;
		}
		if (onset) picked.push(onset);
	}
	const freshest = ambientFrames[ambientFrames.length - 1];
	if (!picked.includes(freshest)) picked.push(freshest);
	return picked.map(f => f.image);
}

/** Newest buffered frame's metadata line, if any. */
export function getAmbientFrameMetadata(): string | undefined {
	return ambientFrames.length ? ambientFrames[ambientFrames.length - 1].metadata : undefined;
}

/** Ambient buffer stats for diagnostics. */
export function getAmbientBufferStats(): { frames: number; running: boolean; newestAgeMs?: number } {
	const newest = ambientFrames[ambientFrames.length - 1];
	return {
		frames: ambientFrames.length,
		running: ambientTimer !== undefined,
		newestAgeMs: newest ? Date.now() - newest.at : undefined,
	};
}
// ---------------------------------------------------------------------------
// Environment-aware Screen Vision grounding (shared by voice & text turns)
// ---------------------------------------------------------------------------
// A turn that attaches a screen capture becomes ENVIRONMENT-AWARE: the model
// learns what the frame is (window, size, why it's attached) via a short
// caption, and — for models that cannot see images — receives the OCR text of
// the frame so it can genuinely READ its environment instead of a dead
// "[image omitted]" placeholder. Nothing here is shown to the user: the caption
// rides inside the model's user content, never on the screen.

export interface ScreenVisionContext {
	/** Environment caption, e.g. `[Screen Vision: kitty — "Aery" (environment · active window · 1200x800)]`. */
	caption: string;
	/** JPEG/PNG frame for vision-capable models. */
	image?: ImageContent;
	/** OCR text for visionless models (empty when OCR unavailable/none). */
	ocrText?: string;
	/** Which mode OCR ran in, if it ran. */
	ocrMode?: "native" | "upscaled";
	/** Window info captured with the frame. */
	window?: ActiveWindowInfo;
}

function formatSize(size?: [number, number]): string {
	return size && size[0] > 0 && size[1] > 0 ? ` · ${size[0]}x${size[1]}` : "";
}

/**
 * Capture the active window (or fullscreen) and build the environment-aware
 * context for a turn:
 *   - caption: always, so the model knows WHAT the frame is and WHY it's attached.
 *   - image: when `supportsImages` (vision-capable) — the JPEG itself.
 *   - ocrText: when NOT `supportsImages` — OCR of the retained file so a
 *     visionless model can read the screen as text.
 * Returns `null` when capture failed (callers should just skip grounding).
 */
export async function buildScreenVisionContext(options: {
	target?: "active_window" | "fullscreen";
	supportsImages: boolean;
	ocrLang?: string;
}): Promise<ScreenVisionContext | null> {
	const { target = "active_window", supportsImages } = options;
	const vision = await captureScreenFrame({ target, keepFile: !supportsImages });
	if (!vision.image && !vision.filePath) return null;

	const win = vision.window;
	const app = target === "fullscreen" ? "Full Display" : win?.class || "Application";
	const title = target === "fullscreen" ? "your entire desktop" : win?.title || "(untitled window)";
	const caption = `[Screen Vision: ${app} — "${title}" (environment${target === "fullscreen" ? " · entire display" : " · active window"}${formatSize(win?.size)})]`;

	if (supportsImages) {
		return { caption, image: vision.image, window: win ?? undefined };
	}

	// Visionless: OCR the retained frame so the model can READ its environment.
	if (!vision.filePath) return { caption, window: win ?? undefined };
	try {
		const ocr = await ocrFrame(vision.filePath, { lang: options.ocrLang });
		return {
			caption,
			ocrText: ocr.text || undefined,
			ocrMode: ocr.mode,
			window: win ?? undefined,
		};
	} finally {
		await fs.rm(vision.filePath, { force: true }).catch(() => {});
	}
}
