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

	/** Enqueue a generation job; the queue drains one job at a time. */
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
		const job: MediaJob = {
			id: `media_${Date.now()}_${this.#nextJobId++}`,
			status: "queued",
			...input,
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
		this.#notify();
	}
}
