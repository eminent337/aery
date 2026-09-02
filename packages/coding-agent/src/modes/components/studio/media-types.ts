/**
 * Type definitions for the AERY Studio "generate" tab (terminal media studio).
 *
 * The generate tab drives the REAL generate_image / generate_video tools via
 * their execute() with a fabricated CustomToolContext, so providers, retries,
 * rate-limit handling and temp-file persistence stay in exactly one place.
 */

export type MediaKind = "image" | "video";

export type MediaJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface MediaJob {
	id: string;
	kind: MediaKind;
	/** User-entered prompt pieces. */
	subject: string;
	action?: string;
	scene?: string;
	style?: string;
	/** Provider + model picked in the studio (from candidate enumerators). */
	provider?: string;
	model?: string;
	/** Image-only params. */
	aspect_ratio?: string;
	/** Video-only params. */
	duration?: number;
	resolution?: string;
	ratio?: string;
	status: MediaJobStatus;
	/** Human-readable progress line ("in progress 40%", "rendering…", …). */
	note?: string;
	startedAt?: number;
	finishedAt?: number;
	/** Tool details merged from execute() results. */
	videoPaths?: string[];
	videoUrls?: string[];
	imagePaths?: string[];
	error?: string;
}

export interface MediaGalleryItem {
	id: string;
	kind: MediaKind;
	/** Absolute file path of the persisted media (copied out of /tmp). */
	path: string;
	provider: string;
	model: string;
	prompt: string;
	timestamp: number;
}
