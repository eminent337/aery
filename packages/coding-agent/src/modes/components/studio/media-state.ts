/**
 * State + sequential job queue for the AERY Studio "generate" tab.
 *
 * Jobs call the REAL generate_image / generate_video tool execute() with a
 * fabricated CustomToolContext (same shape the test suites use), so provider
 * logic, retries and rate-limit handling stay in exactly one place. The chat
 * tools are untouched — the studio is purely additive.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolContext } from "../../../extensibility/custom-tools/types";
import { type ImageGenParams, imageGenTool } from "../../../tools/image-gen";
import { type VideoGenParams, videoGenTool } from "../../../tools/video-gen";
import type { MediaGalleryItem, MediaJob, MediaJobStatus, MediaKind } from "./media-types";

/** Static status → short label (fixed string keys → Record). */
const STATUS_LABEL: Record<MediaJobStatus, string> = {
	queued: "queued",
	running: "rendering…",
	completed: "done",
	failed: "failed",
	cancelled: "cancelled",
};

export interface MediaStateSnapshot {
	jobs: MediaJob[];
	gallery: MediaGalleryItem[];
	/** Index into gallery of the selected item (-1 = none). */
	selectedIndex: number;
	statusMessage?: string;
}

export interface MediaContextSpec {
	/** Model registry from the live session (ctx.modelRegistry). */
	modelRegistry: CustomToolContext["modelRegistry"];
	sessionId: string;
	/** Working directory used to resolve input images (imageGenTool needs it). */
	cwd: string;
}

export class MediaStateManager {
	static #instance?: MediaStateManager;

	static instance(): MediaStateManager {
		if (!MediaStateManager.#instance) {
			MediaStateManager.#instance = new MediaStateManager();
		}
		return MediaStateManager.#instance;
	}

	#jobs: MediaJob[] = [];
	#gallery: MediaGalleryItem[] = [];
	#selectedIndex = -1;
	#listeners = new Set<() => void>();
	#contextSpec?: MediaContextSpec;
	#running = false;
	#nextJobId = 1;
	#statusMessage?: string;

	subscribe(fn: () => void): () => void {
		this.#listeners.add(fn);
		return () => {
			this.#listeners.delete(fn);
		};
	}

	#notify(): void {
		for (const fn of this.#listeners) {
			try {
				fn();
			} catch {
				// Listener render errors must never break the queue.
			}
		}
	}

	/** Wire the live-session context once when the studio opens. */
	setContext(spec: MediaContextSpec | undefined): void {
		this.#contextSpec = spec;
		this.#statusMessage = spec ? undefined : "studio not attached to a session";
	}

	/** Live-session context spec (model registry etc.) for candidate enumeration. */
	getContextSpec(): MediaContextSpec | undefined {
		return this.#contextSpec;
	}

	/** Static label for a job status (Record lookup, no dynamic Set needed). */
	statusLabel(status: MediaJobStatus): string {
		return STATUS_LABEL[status];
	}

	getSnapshot(): MediaStateSnapshot {
		return {
			jobs: [...this.#jobs],
			gallery: [...this.#gallery],
			selectedIndex: this.#selectedIndex,
			statusMessage: this.#statusMessage,
		};
	}

	// ---- Generation settings (fal-style: model + aspect + duration) ----

	/** Image aspect ratios supported by the common image providers. */
	static readonly IMAGE_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
	/** Video aspect ratios supported by the video providers. */
	static readonly VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
	/** Video length steps in seconds (tool allows 3–15). */
	static readonly VIDEO_DURATIONS = [3, 5, 8, 10, 15] as const;
	/** Video resolution tiers. */
	static readonly VIDEO_RESOLUTIONS = ["480P", "768P", "1080P", "2K"] as const;

	#imageRatio?: string;
	#videoRatio?: string;
	#videoDuration?: number;
	#videoResolution?: string;
	#imageModel?: { provider: string; model: string };
	#videoModel?: { provider: string; model: string };

	/** Current image-mode settings. */
	get imageSettings(): { aspectRatio?: string; model?: string; provider?: string } {
		return {
			aspectRatio: this.#imageRatio,
			model: this.#imageModel?.model,
			provider: this.#imageModel?.provider,
		};
	}

	/** Current video-mode settings. */
	get videoSettings(): {
		ratio?: string;
		duration?: number;
		resolution?: string;
		model?: string;
		provider?: string;
	} {
		return {
			ratio: this.#videoRatio,
			duration: this.#videoDuration,
			resolution: this.#videoResolution,
			model: this.#videoModel?.model,
			provider: this.#videoModel?.provider,
		};
	}

	/** Cycle to the next image aspect ratio (wraps to undefined = provider default). */
	cycleImageRatio(): void {
		const opts = [...MediaStateManager.IMAGE_RATIOS, undefined];
		const idx = opts.indexOf(this.#imageRatio as (typeof opts)[number]);
		this.#imageRatio = opts[(idx + 1) % opts.length];
		this.#notify();
	}

	/** Cycle to the next video aspect ratio (wraps to undefined = provider default). */
	cycleVideoRatio(): void {
		const opts = [...MediaStateManager.VIDEO_RATIOS, undefined];
		const idx = opts.indexOf(this.#videoRatio as (typeof opts)[number]);
		this.#videoRatio = opts[(idx + 1) % opts.length];
		this.#notify();
	}

	/** Cycle video length: default → 3 → 5 → 8 → 10 → 15 → default. */
	cycleVideoDuration(): void {
		const opts: (number | undefined)[] = [...MediaStateManager.VIDEO_DURATIONS, undefined];
		const idx = opts.indexOf(this.#videoDuration);
		this.#videoDuration = opts[(idx + 1) % opts.length];
		this.#notify();
	}

	/** Cycle video resolution: default → 480P → 768P → 1080P → 2K → default. */
	cycleVideoResolution(): void {
		const opts: (string | undefined)[] = [...MediaStateManager.VIDEO_RESOLUTIONS, undefined];
		const idx = opts.indexOf(this.#videoResolution);
		this.#videoResolution = opts[(idx + 1) % opts.length];
		this.#notify();
	}

	/** Set the model for the current mode from a live candidate pick. */
	setModelPick(kind: MediaKind, pick: { provider: string; model: string } | undefined): void {
		if (kind === "image") {
			this.#imageModel = pick;
		} else {
			this.#videoModel = pick;
		}
		this.#notify();
	}

	/**
	 * Enqueue a generation job; the queue drains one job at a time. Settings
	 * (aspect ratio, duration, resolution, model) default to the studio's
	 * current picks and can be overridden per call (tests do this).
	 */
	enqueue(input: {
		kind: MediaKind;
		subject: string;
		action?: string;
		scene?: string;
		style?: string;
		provider?: string;
		model?: string;
		aspect_ratio?: string;
		duration?: number;
		resolution?: string;
		ratio?: string;
	}): void {
		const kind = input.kind;
		const withSettings: typeof input = {
			...input,
			aspect_ratio: input.aspect_ratio ?? (kind === "image" ? this.#imageRatio : undefined),
			ratio: input.ratio ?? (kind === "video" ? this.#videoRatio : undefined),
			duration: input.duration ?? (kind === "video" ? this.#videoDuration : undefined),
			resolution: input.resolution ?? (kind === "video" ? this.#videoResolution : undefined),
			model: input.model ?? (kind === "image" ? this.#imageModel?.model : this.#videoModel?.model),
			provider: input.provider ?? (kind === "image" ? this.#imageModel?.provider : this.#videoModel?.provider),
		};
		const job: MediaJob = {
			id: `media_${Date.now()}_${this.#nextJobId++}`,
			status: "queued",
			...withSettings,
		};
		this.#jobs.push(job);
		if (this.#jobs.length > 50) this.#jobs.shift();
		this.#notify();
		this.#drain();
	}

	/** Cancel a queued (not yet running) job by id. */
	cancelQueued(id: string): void {
		const job = this.#jobs.find(j => j.id === id);
		if (job && job.status === "queued") {
			job.status = "cancelled";
			this.#notify();
		}
	}

	/** Move the gallery selection by ±1 (arrow keys). */
	moveSelection(delta: number): void {
		if (this.#gallery.length === 0) return;
		const max = this.#gallery.length - 1;
		const next = Math.min(Math.max(this.#selectedIndex + delta, 0), max);
		if (next !== this.#selectedIndex) {
			this.#selectedIndex = next;
			this.#notify();
		}
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			for (;;) {
				const job = this.#jobs.find(j => j.status === "queued");
				if (!job) break;
				await this.#runJob(job);
			}
		} finally {
			this.#running = false;
		}
	}

	async #runJob(job: MediaJob): Promise<void> {
		job.status = "running";
		job.startedAt = Date.now();
		this.#notify();

		const spec = this.#contextSpec;
		if (!spec) {
			job.status = "failed";
			job.error = "studio not attached to a session";
			job.finishedAt = Date.now();
			this.#notify();
			return;
		}

		const onUpdate: (update: { content: Array<{ type: string; text?: string }> }) => void = update => {
			const first = update.content[0];
			if (first?.type === "text" && typeof first.text === "string") {
				job.note = first.text;
				this.#notify();
			}
		};
		const ctx = {
			sessionManager: {
				getSessionId: () => spec.sessionId,
				getCwd: () => spec.cwd,
			},
			modelRegistry: spec.modelRegistry,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as CustomToolContext;

		try {
			let details: {
				provider?: string;
				model?: string;
				imagePaths?: string[];
				videoPaths?: string[];
				videoUrls?: string[];
			};

			if (job.kind === "image") {
				const params: ImageGenParams = {
					subject: job.subject,
				};
				if (job.action) params.action = job.action;
				if (job.scene) params.scene = job.scene;
				if (job.style) params.style = job.style;
				if (job.provider) params.provider = job.provider as ImageGenParams["provider"];
				if (job.model) params.model = job.model;
				if (job.aspect_ratio) {
					params.aspect_ratio = job.aspect_ratio as ImageGenParams["aspect_ratio"];
				}
				const result = await imageGenTool.execute(job.id, params, onUpdate, ctx, undefined);
				details = result.details as typeof details;
			} else {
				const params: VideoGenParams = {
					subject: job.subject,
				};
				if (job.action) params.action = job.action;
				if (job.scene) params.scene = job.scene;
				if (job.style) params.style = job.style;
				if (job.provider) params.provider = job.provider as VideoGenParams["provider"];
				if (job.model) params.model = job.model;
				if (job.duration !== undefined) params.duration = job.duration;
				if (job.resolution) params.resolution = job.resolution as VideoGenParams["resolution"];
				if (job.ratio) params.ratio = job.ratio as VideoGenParams["ratio"];
				const result = await videoGenTool.execute(job.id, params, onUpdate, ctx, undefined);
				details = result.details as typeof details;
			}

			job.provider = details.provider ?? job.provider;
			job.model = details.model ?? job.model;
			job.imagePaths = details.imagePaths;
			job.videoPaths = details.videoPaths;
			job.videoUrls = details.videoUrls;
			job.status = "completed";
			job.note = undefined;
			job.error = undefined;
			job.finishedAt = Date.now();
		} catch (error) {
			job.status = "failed";
			job.error = error instanceof Error ? error.message : String(error);
			job.finishedAt = Date.now();
		}

		this.#notify();
		this.#archiveToGallery(job);
	}

	#archiveToGallery(job: MediaJob): void {
		void this.#archiveToGalleryAsync(job);
	}

	/**
	 * Copy completed renders into ~/.aery/studio/ (temp files do not survive
	 * reboots) and record gallery entries pointing at the persistent copies.
	 */
	async #archiveToGalleryAsync(job: MediaJob): Promise<void> {
		if (job.status !== "completed") return;
		const paths = job.kind === "image" ? (job.imagePaths ?? []) : (job.videoPaths ?? []);
		const dir = path.join(os.homedir(), ".aery", "studio", job.kind === "image" ? "images" : "videos");
		try {
			await fs.mkdir(dir, { recursive: true });
		} catch {
			// Persistence is best-effort; fall back to the temp path below.
		}

		for (const srcPath of paths) {
			let storedPath = srcPath;
			const ext = path.extname(srcPath) || (job.kind === "image" ? ".png" : ".mp4");
			const fileName = `${new Date(job.finishedAt ?? Date.now()).toISOString().replace(/[:.]/g, "-")}${ext}`;
			try {
				const destPath = path.join(dir, fileName);
				await fs.copyFile(srcPath, destPath);
				storedPath = destPath;
			} catch {
				// Keep the temp path if the copy fails.
			}

			this.#gallery.unshift({
				id: `${job.id}:${storedPath}`,
				kind: job.kind,
				path: storedPath,
				provider: job.provider ?? "auto",
				model: job.model ?? "auto",
				prompt: job.subject,
				timestamp: job.finishedAt ?? Date.now(),
			});
		}
		if (this.#gallery.length > 50) this.#gallery.length = 50;
		this.#selectedIndex = 0;
		this.#notify();
	}
}
