/**
 * AERY Studio "generate" tab: prompt-driven image/video generation hub.
 *
 * Layout:
 *   ✦ Generate   [● Image] ( Video )   model: auto (best free)
 *   tab = switch mode · m = pick model · enter = generate · ←/→ = gallery
 *
 *   prompt > a hummingbird over a red flower▊
 *
 *   Queue
 *     ▶ Video · hummingbird — rendering… 40% (30s elapsed)
 *     ✓ Image · skyline sketch — done
 *
 *   Gallery
 *     ▶ 🖼 skyline sketch · agnes/agnes-image-2.5-flash
 *       🎬 hummingbird · agnes/agnes-video-2.5-flash
 *
 * Generation goes through MediaStateManager → the REAL generate_image /
 * generate_video tool execute() — providers, retries and rate limits live in
 * exactly one place; the chat tool cards are untouched.
 */

import { Container, Input, matchesKey, Spacer, Text } from "@aryee337/aery-tui";
import { theme } from "../../theme/theme.js";
import type { MediaStateSnapshot } from "./media-state.js";
import type { MediaJob, MediaKind } from "./media-types.js";

/** Static kind → icon lookup (fixed string keys → Record). */
const KIND_ICON: Record<MediaKind, string> = {
	image: "🖼",
	video: "🎬",
};

const KIND_LABEL: Record<MediaKind, string> = {
	image: "Image",
	video: "Video",
};

export interface MediaPanelCallbacks {
	/** User pressed Enter on a non-empty prompt. */
	onGenerate: (kind: MediaKind, prompt: string) => void;
	/** Arrow keys moved the gallery selection. */
	onMoveSelection: (delta: number) => void;
	/** Enter on a selected gallery video → open in the video player. */
	onOpenInPlayer: (videoPath: "selected" | (string & {})) => void;
}

export class StudioMediaPanel extends Container {
	#mode: MediaKind = "image";
	#model: string | undefined;
	#snapshot: MediaStateSnapshot;
	#callbacks: MediaPanelCallbacks;
	#promptInput: Input;

	constructor(snapshot: MediaStateSnapshot, callbacks: MediaPanelCallbacks) {
		super();
		this.#snapshot = snapshot;
		this.#callbacks = callbacks;
		this.#promptInput = new Input();
		this.#promptInput.prompt = "  prompt > ";
		this.#buildLayout();
	}

	/** Called by the overlay when the media state store emits an update. */
	updateSnapshot(snapshot: MediaStateSnapshot): void {
		this.#snapshot = snapshot;
		this.#buildLayout();
	}

	/** Current prompt-box text (the overlay may need it for the picker flow). */
	getPrompt(): string {
		return this.#promptInput.getValue();
	}

	/** Overlay-driven model pick (from the candidate enumerator list). */
	setModel(model: string | undefined): void {
		this.#model = model;
		this.#buildLayout();
	}

	/** Current generation mode (Image/Video). */
	getMode(): MediaKind {
		return this.#mode;
	}

	/** Overlay-driven mode switch (tab in the header). */
	setMode(kind: MediaKind): void {
		this.#mode = kind;
		this.#buildLayout();
	}

	#buildLayout(): void {
		this.clear();

		// Header: mode toggle + model line
		const imageTab = this.#mode === "image" ? "[● Image]" : "(  Image )";
		const videoTab = this.#mode === "video" ? "[● Video]" : "(  Video )";
		const modelLine = this.#model ? `model: ${this.#model}` : "model: auto (best free)";
		this.addChild(
			new Text(theme.bold(theme.fg("accent", `  ✦ Generate   ${imageTab}  ${videoTab}   ${modelLine}`)), 0, 0),
		);
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"  tab = switch mode · m = pick model · enter = generate · ←/→ = gallery · enter on 🎬 = play",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Prompt input
		this.addChild(this.#promptInput);
		this.addChild(new Spacer(1));

		// Queue: up to 4 most recent jobs (oldest first)
		this.addChild(new Text(theme.bold("  Queue"), 0, 0));
		const jobs = this.#snapshot.jobs.slice(-4);
		if (jobs.length === 0) {
			this.addChild(new Text(theme.fg("muted", "    (no jobs yet — type a prompt and press Enter)"), 0, 0));
		} else {
			for (const job of jobs) {
				this.addChild(this.#jobLine(job));
			}
		}
		this.addChild(new Spacer(1));

		// Gallery strip
		this.addChild(new Text(theme.bold("  Gallery"), 0, 0));
		const gallery = this.#snapshot.gallery;
		if (gallery.length === 0) {
			this.addChild(new Text(theme.fg("muted", "    (empty — completed renders land here)"), 0, 0));
		} else {
			for (let i = 0; i < Math.min(gallery.length, 8); i++) {
				const item = gallery[i];
				const selected = i === this.#snapshot.selectedIndex;
				const marker = selected ? theme.fg("accent", " ▶") : "  ";
				const icon = KIND_ICON[item.kind];
				this.addChild(
					new Text(`${marker} ${icon} ${item.prompt.slice(0, 48)}  ·  ${item.provider}/${item.model}`, 0, 0),
				);
			}
			const selected = gallery[this.#snapshot.selectedIndex];
			if (selected && selected.kind === "video") {
				this.addChild(
					new Text(
						theme.fg("muted", "    ⏎ open in player · alt+p play/pause · alt+←/→ seek · alt+x close"),
						0,
						0,
					),
				);
			}
		}
	}

	#jobLine(job: MediaJob): Text {
		const icon =
			job.status === "running"
				? theme.fg("warning", "▶")
				: job.status === "completed"
					? theme.fg("success", "✓")
					: job.status === "failed"
						? theme.fg("error", "✗")
						: theme.fg("muted", "·");
		const note = job.note ?? job.error ?? "";
		const kindLabel = KIND_LABEL[job.kind];
		return new Text(`    ${icon} ${kindLabel} · ${job.subject.slice(0, 40)}${note ? ` — ${note}` : ""}`, 0, 0);
	}

	/**
	 * Studio media-tab key handling, called by the overlay AFTER its own
	 * global keys. Returns true when the key was consumed.
	 */
	handleMediaKey(data: string): boolean {
		// Tab toggles Image/Video (the overlay's TabBar consumes its own tab
		// handling first, so this only fires when the overlay delegates).
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const delta = matchesKey(data, "left") ? -1 : 1;
			this.#callbacks.onMoveSelection(delta);
			return true;
		}
		if (data === "\r" || data === "\n") {
			const prompt = this.#promptInput.getValue().trim();
			if (prompt.length === 0) {
				// Empty prompt + selected video → open in the player.
				const selected = this.#snapshot.gallery[this.#snapshot.selectedIndex];
				if (selected && selected.kind === "video") {
					this.#callbacks.onOpenInPlayer(selected.path);
					return true;
				}
				return true;
			}
			this.#callbacks.onGenerate(this.#mode, prompt);
			this.#promptInput.setValue("");
			this.#buildLayout();
			return true;
		}
		return false;
	}

	/** Let the Input component consume typing keys. */
	handleTextInput(data: string): boolean {
		const before = this.#promptInput.getValue();
		this.#promptInput.handleInput(data);
		return before !== this.#promptInput.getValue() || data === "\r" || data === "\n";
	}
}
