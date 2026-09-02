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

/** Static cycle lists (first entry = provider default). */
const IMAGE_RATIOS = [undefined, "1:1", "3:4", "4:3", "9:16", "16:9"] as const;
const VIDEO_RATIOS = [undefined, "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const VIDEO_DURATIONS = [undefined, 3, 5, 8, 10, 15] as const;
const VIDEO_RESOLUTIONS = [undefined, "480P", "768P", "1080P", "2K"] as const;

/** Compute the next entry in a cycle list (wraps past the end). */
function nextIn<T>(list: readonly (T | undefined)[], current: T | undefined): T | undefined {
	const idx = list.indexOf(current);
	return list[(idx + 1) % list.length];
}

export interface MediaPanelCallbacks {
	/** User pressed Enter on a non-empty prompt. */
	onGenerate: (kind: MediaKind, prompt: string) => void;
	/** Arrow keys moved the gallery selection. */
	onMoveSelection: (delta: number) => void;
	/** Enter on a selected gallery video → open in the video player. */
	onOpenInPlayer: (videoPath: "selected" | (string & {})) => void;
	/** User confirmed a pick in the model picker (undefined = back to auto). */
	onPickModel?: (label: string | undefined) => void;
}

export class StudioMediaPanel extends Container {
	#mode: MediaKind = "image";
	#model: string | undefined;
	#snapshot: MediaStateSnapshot;
	#callbacks: MediaPanelCallbacks;
	#promptInput: Input;
	/** Settings cycle state (undefined = provider default). */
	#imageRatio?: string;
	#videoRatio?: string;
	#videoDuration?: number;
	#videoResolution?: string;
	/** Open model picker state (labels from overlay enumeration, cursor). */
	#pickerItems: string[] = [];
	#pickerIndex = 0;

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

	/** Cycle image aspect ratio (wraps back to provider default). */
	cycleImageRatio(): void {
		this.#imageRatio = nextIn(IMAGE_RATIOS, this.#imageRatio);
		this.#buildLayout();
	}

	/** Cycle video aspect ratio (wraps back to provider default). */
	cycleVideoRatio(): void {
		this.#videoRatio = nextIn(VIDEO_RATIOS, this.#videoRatio);
		this.#buildLayout();
	}

	/** Cycle video length (wraps back to provider default). */
	cycleVideoDuration(): void {
		this.#videoDuration = nextIn(VIDEO_DURATIONS, this.#videoDuration);
		this.#buildLayout();
	}

	/** Cycle video resolution (wraps back to provider default). */
	cycleVideoResolution(): void {
		this.#videoResolution = nextIn(VIDEO_RESOLUTIONS, this.#videoResolution);
		this.#buildLayout();
	}

	/** Open the model picker with labels enumerated by the overlay. */
	openPicker(items: string[]): void {
		if (items.length === 0) return;
		this.#pickerItems = items;
		this.#pickerIndex = 0;
		this.#buildLayout();
	}

	closePicker(): void {
		this.#pickerItems = [];
		this.#pickerIndex = 0;
		this.#buildLayout();
	}

	get isPickerOpen(): boolean {
		return this.#pickerItems.length > 0;
	}

	/** Move the picker cursor (wraps). */
	movePicker(delta: number): void {
		if (this.#pickerItems.length === 0) return;
		const n = this.#pickerItems.length;
		this.#pickerIndex = (this.#pickerIndex + delta + n) % n;
		this.#buildLayout();
	}

	/** Currently highlighted picker label. */
	get pickerSelection(): string | undefined {
		return this.#pickerItems[this.#pickerIndex];
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
		const settings = this.#settingsLine();
		this.addChild(
			new Text(theme.bold(theme.fg("accent", `  ✦ Generate   ${imageTab}  ${videoTab}   ${settings}`)), 0, 0),
		);
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"  tab mode · alt+a aspect · alt+d length · alt+r res · alt+m model · enter generate · ←/→ gallery",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Prompt input
		this.addChild(this.#promptInput);
		this.addChild(new Spacer(1));

		// Live model picker (alt+m) — sits between prompt and queue.
		if (this.#pickerItems.length > 0) {
			this.addChild(new Text(theme.bold("  Pick a model:"), 0, 0));
			for (let i = 0; i < this.#pickerItems.length; i++) {
				const marker = i === this.#pickerIndex ? theme.fg("accent", " ▶") : "  ";
				this.addChild(new Text(`${marker} ${this.#pickerItems[i]}`, 0, 0));
			}
			this.addChild(new Text(theme.fg("muted", "    ↑/↓ move · enter confirm · esc cancel"), 0, 0));
			this.addChild(new Spacer(1));
		}

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

	/** fal-style settings summary for the current mode. */
	#settingsLine(): string {
		const model = this.#model ?? "auto (best free)";
		if (this.#mode === "image") {
			return `model: ${model} · ratio ${this.#imageRatio ?? "default"}`;
		}
		const len = this.#videoDuration === undefined ? "—" : `${this.#videoDuration}s`;
		const res = this.#videoResolution ?? "—";
		return `model: ${model} · ratio ${this.#videoRatio ?? "default"} · len ${len} · res ${res}`;
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
		// Model picker navigation first (it owns ↑/↓/enter/esc while open).
		if (this.#pickerItems.length > 0) {
			if (matchesKey(data, "up")) {
				this.movePicker(-1);
				return true;
			}
			if (matchesKey(data, "down")) {
				this.movePicker(1);
				return true;
			}
			if (data === "\r" || data === "\n") {
				this.#callbacks.onPickModel?.(this.pickerSelection);
				this.closePicker();
				return true;
			}
			if (matchesKey(data, "escape")) {
				this.closePicker();
				return true;
			}
		}

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
