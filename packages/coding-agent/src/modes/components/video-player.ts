import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Component, Image, matchesKey, TERMINAL } from "@aryee337/aery-tui";

/**
 * Inline terminal video player.
 *
 * Extracts frames from the MP4 with ffmpeg/ffprobe and cycles them through the
 * TUI Image component (kitty/sixel/iTerm2). Controls are global alt-chords via
 * a TUI input listener, so the chat editor keeps working while the video
 * plays — no focus is stolen:
 *
 *   alt+p play/pause · alt+left/alt+right seek ±1s · alt+r restart · alt+x close
 *
 * The player mounts as a child of the generate_video tool card, below the
 * rendered result, with a controls line advertising the keybindings.
 */

const VIDEO_PLAYER_FPS = 12;
const VIDEO_PLAYER_MAX_FRAMES = 240;
const VIDEO_PLAYER_FRAME_MS = Math.round(1000 / VIDEO_PLAYER_FPS);

interface ExtractedFrames {
	paths: string[];
	durationSeconds: number;
	widthPx: number;
	heightPx: number;
}

/** Static status lookup table (Record per house rules). */
const STATUS_LABEL: Record<string, string> = { playing: "playing", paused: "paused" };

export interface VideoPlayerTheme {
	fallbackColor: (str: string) => string;
	accentColor: (str: string) => string;
	dimColor: (str: string) => string;
	successColor: (str: string) => string;
}

/** Outcome when the player could not start (missing ffmpeg, tiny video, …). */
export interface VideoPlayerSetup {
	ready: boolean;
	error?: string;
}

export class VideoPlayer implements Component {
	#frames: ExtractedFrames | undefined;
	#frameData: string[] = [];
	#cleanupPaths: string[] = [];
	#setup: VideoPlayerSetup = { ready: false };
	#playing = false;
	#frameIndex = 0;
	#currentImage: Image | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#ui:
		| {
				addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void;
				requestRender(): void;
		  }
		| undefined;
	#removeListener: (() => void) | undefined;
	#theme: VideoPlayerTheme;
	#closed = false;

	constructor(
		private readonly videoPath: string,
		theme: VideoPlayerTheme,
	) {
		this.#theme = theme;
	}

	get setup(): VideoPlayerSetup {
		return this.#setup;
	}

	async start(ui: {
		addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void;
		requestRender(): void;
	}): Promise<VideoPlayerSetup> {
		this.#ui = ui;
		this.#removeListener = ui.addInputListener(data => this.#handleGlobalKey(data));
		const setup = await this.#extractFrames();
		this.#setup = setup;
		if (setup.ready) {
			this.#playing = true;
			this.#timer = setInterval(() => this.#advanceFrame(), VIDEO_PLAYER_FRAME_MS);
			this.#loadCurrentImage();
		}
		return setup;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#removeListener?.();
		this.#removeListener = undefined;
		void Promise.all(this.#cleanupPaths.map(p => fs.rm(p, { force: true }).catch(() => undefined)));
	}

	/** Global alt-chord handler — consumes only player chords, passes everything else through. */
	#handleGlobalKey(data: string): { consume?: boolean } | undefined {
		if (this.#closed || !this.#frames) return undefined;
		if (matchesKey(data, "alt+p")) {
			this.#togglePlay();
			return { consume: true };
		}
		if (matchesKey(data, "alt+left")) {
			this.#seek(-1);
			return { consume: true };
		}
		if (matchesKey(data, "alt+right")) {
			this.#seek(1);
			return { consume: true };
		}
		if (matchesKey(data, "alt+r")) {
			this.#frameIndex = 0;
			this.#playing = true;
			this.#restartTimer();
			this.#loadCurrentImage();
			this.#ui?.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "alt+x")) {
			this.close();
			this.#ui?.requestRender();
			return { consume: true };
		}
		return undefined;
	}

	#togglePlay(): void {
		this.#playing = !this.#playing;
		this.#restartTimer();
		this.#ui?.requestRender();
	}

	#seek(deltaSeconds: number): void {
		if (!this.#frames) return;
		const deltaFrames = Math.round(deltaSeconds * VIDEO_PLAYER_FPS);
		const total = this.#frames.paths.length;
		let next = this.#frameIndex + deltaFrames;
		if (next < 0) next = 0;
		if (next >= total) next = total - 1;
		this.#frameIndex = next;
		this.#loadCurrentImage();
		this.#ui?.requestRender();
	}

	#restartTimer(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		if (this.#playing && this.#frames) {
			this.#timer = setInterval(() => this.#advanceFrame(), VIDEO_PLAYER_FRAME_MS);
		}
	}

	#advanceFrame(): void {
		if (!this.#frames || !this.#playing) return;
		const total = this.#frames.paths.length;
		this.#frameIndex = (this.#frameIndex + 1) % total;
		this.#loadCurrentImage();
		this.#ui?.requestRender();
	}

	async #extractFrames(): Promise<VideoPlayerSetup> {
		try {
			const probe = spawnSync(
				"ffprobe",
				[
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_entries",
					"stream=width,height,duration",
					"-of",
					"json",
					this.videoPath,
				],
				{ timeout: 10_000 },
			);
			if (probe.status !== 0 || !probe.stdout) {
				return { ready: false, error: "ffprobe could not read the video" };
			}
			const parsed = JSON.parse(probe.stdout.toString()) as {
				streams?: Array<{ width?: number; height?: number; duration?: string }>;
			};
			const stream = parsed.streams?.[0];
			if (!stream?.width || !stream?.height) {
				return { ready: false, error: "video metadata missing dimensions" };
			}
			const duration = Number.parseFloat(stream.duration ?? "0");
			if (!Number.isFinite(duration) || duration <= 0) {
				return { ready: false, error: "video metadata missing duration" };
			}

			const outDir = path.join(os.tmpdir(), `aery-video-frames-${Date.now()}`);
			await fs.mkdir(outDir, { recursive: true });
			this.#cleanupPaths.push(outDir);

			// Cap frames so long videos stay within memory bounds.
			const sourceFps = Math.min(VIDEO_PLAYER_FPS, Math.ceil(VIDEO_PLAYER_MAX_FRAMES / duration));
			await new Promise<void>((resolve, reject) => {
				const child = spawnSync(
					"ffmpeg",
					[
						"-v",
						"error",
						"-i",
						this.videoPath,
						"-vf",
						`fps=${sourceFps}`,
						"-frames:v",
						String(VIDEO_PLAYER_MAX_FRAMES),
						path.join(outDir, "frame-%04d.png"),
					],
					{ timeout: 30_000 },
				);
				if (child.status !== 0) {
					reject(new Error(child.stderr?.toString().slice(0, 200) ?? "ffmpeg failed"));
				} else {
					resolve();
				}
			});

			const files = (await fs.readdir(outDir)).filter(f => f.endsWith(".png")).sort();
			if (files.length === 0) {
				return { ready: false, error: "no frames could be extracted" };
			}
			this.#frames = {
				paths: files.map(f => path.join(outDir, f)),
				durationSeconds: duration,
				widthPx: stream.width,
				heightPx: stream.height,
			};
			return { ready: true };
		} catch (error) {
			return { ready: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	#loadCurrentImage(): void {
		if (!this.#frames) return;
		const framePath = this.#frames.paths[this.#frameIndex];
		void Bun.file(framePath)
			.arrayBuffer()
			.then(buffer => {
				this.#frameData[this.#frameIndex] = Buffer.from(buffer).toString("base64");
				this.#currentImage = new Image(
					this.#frameData[this.#frameIndex],
					"image/png",
					{ fallbackColor: this.#theme.fallbackColor },
					{ filename: path.basename(this.videoPath) },
				);
			})
			.catch(() => {
				// Frame load failures are non-fatal — the next tick retries.
			});
	}

	invalidate(): void {
		this.#currentImage?.invalidate();
	}

	#controlsLine(width: number): string[] {
		const state = this.#playing ? STATUS_LABEL.playing : STATUS_LABEL.paused;
		const total = this.#frames?.durationSeconds ?? 0;
		const elapsed = this.#frames ? this.#frameIndex / VIDEO_PLAYER_FPS : 0;
		const fmt = (s: number): string => {
			const m = Math.floor(s / 60);
			const sec = Math.floor(s % 60);
			return `${m}:${String(sec).padStart(2, "0")}`;
		};
		const controls = this.#theme.accentColor(
			`${this.#playing ? "⏸" : "▶"} ${state}  ${fmt(elapsed)} / ${fmt(total)}`,
		);
		const keys = this.#theme.dimColor("alt+p play/pause · alt+←/→ seek ±1s · alt+r restart · alt+x close");
		const line = `${controls}   ${keys}`;
		return [line.length > width - 2 ? line.slice(0, width - 2) : line];
	}

	render(width: number): string[] {
		if (this.#closed) return [];
		if (!this.#setup.ready) {
			return [this.#theme.dimColor(`[Video player unavailable: ${this.#setup.error ?? "unknown error"}]`)];
		}
		if (!TERMINAL.imageProtocol) {
			return [this.#theme.fallbackColor(`[Video: ${path.basename(this.videoPath)}]`), ...this.#controlsLine(width)];
		}
		const lines: string[] = [];
		if (this.#currentImage) {
			lines.push(...this.#currentImage.render(width));
		} else {
			lines.push(this.#theme.dimColor("Loading first frame…"));
		}
		lines.push(...this.#controlsLine(width));
		return lines;
	}
}
