/**
 * AERY Media Studio — standalone full-screen image & video generation studio.
 *
 * A focused surface (opened via `/studio`) that puts the real generate_image /
 * generate_video tool flow front and center: prompt bar, Image/Video toggle,
 * live job queue, persistent gallery, and inline video playback. It reuses
 * StudioMediaPanel + MediaStateManager so providers/retries/rate-limits stay
 * in exactly one place; the chat tool cards are untouched.
 *
 * Contrast with AeryStudioOverlay (F2): that is the multi-agent war-room; this
 * is the media Hub the user asked for ("like settings / hub").
 */

import * as fs from "node:fs";
import { Container, Image, matchesKey } from "@aryee337/aery-tui";
import { enumerateImageCandidates } from "../../../tools/image-gen";
import { enumerateVideoCandidates } from "../../../tools/video-gen";
import { theme } from "../../theme/theme.js";
import { VideoPlayer, type VideoPlayerTheme } from "../video-player.js";
import { MediaStateManager } from "./media-state.js";
import type { MediaGalleryItem } from "./media-types.js";
import { StudioMediaPanel } from "./studio-media-panel.js";

/** Bottom chrome lines: blank, footer, bottom border. */
const BOTTOM_CHROME = 3;

/** Mime type from file extension (Record per house rules). */
const EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

export class AeryMediaStudioOverlay extends Container {
	#mediaPanel: StudioMediaPanel;
	#mediaUnsubscribe?: () => void;
	#videoPlayer?: VideoPlayer;
	#playerKeyListener?: (data: string) => { consume?: boolean } | undefined;
	/** Cached preview for the currently selected gallery image. */
	#previewImage?: Image;
	#previewPath?: string;
	/** Captured live-session context for async candidate enumeration. */
	#modelRegistry?: Parameters<typeof enumerateImageCandidates>[0];
	/** Guard so alt+m doesn't stack overlapping enumerations. */
	#enumerating = false;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor() {
		super();
		const mediaManager = MediaStateManager.instance();
		this.#modelRegistry = mediaManager.getContextSpec()?.modelRegistry;
		this.#mediaPanel = new StudioMediaPanel(mediaManager.getSnapshot(), {
			onGenerate: (kind, prompt) => {
				mediaManager.enqueue({ kind, subject: prompt });
			},
			onMoveSelection: delta => {
				mediaManager.moveSelection(delta);
			},
			onOpenInPlayer: (videoPath: string) => {
				void this.#openInPlayer(videoPath);
			},
			onPickModel: label => {
				this.#applyModelPick(label);
			},
		});

		this.#mediaUnsubscribe = mediaManager.subscribe(() => {
			const snap = MediaStateManager.instance().getSnapshot();
			this.#mediaPanel.updateSnapshot(snap);
			this.#loadPreview(snap.gallery[snap.selectedIndex]);
			this.onRequestRender?.();
		});

		this.#loadPreview(mediaManager.getSnapshot().gallery[mediaManager.getSnapshot().selectedIndex]);
	}

	dispose(): void {
		this.#mediaUnsubscribe?.();
		this.#closeVideoPlayer();
	}

	/** Open a completed video in the inline frame-cycling player. */
	async #openInPlayer(videoPath: string): Promise<void> {
		this.#closeVideoPlayer();
		const playerTheme: VideoPlayerTheme = {
			fallbackColor: (s: string) => theme.fg("toolOutput", s),
			accentColor: (s: string) => theme.fg("accent", s),
			dimColor: (s: string) => theme.fg("toolOutput", s),
			successColor: (s: string) => theme.fg("success", s),
		};
		const player = new VideoPlayer(videoPath, playerTheme);
		this.#videoPlayer = player;
		const setup = await player.start({
			addInputListener: listener => {
				this.#playerKeyListener = listener;
				return () => {
					if (this.#playerKeyListener === listener) this.#playerKeyListener = undefined;
				};
			},
			requestRender: () => this.onRequestRender?.(),
		});
		if (!setup.ready) {
			this.#closeVideoPlayer();
		}
		this.onRequestRender?.();
	}

	#closeVideoPlayer(): void {
		this.#videoPlayer?.close();
		this.#videoPlayer = undefined;
		this.#playerKeyListener = undefined;
	}

	/** alt+m: enumerate live candidates and open the in-panel model picker. */
	async #openModelPicker(): Promise<void> {
		if (this.#enumerating || this.#mediaPanel.isPickerOpen) return;
		const kind = this.#mediaPanel.getMode();
		const spec = MediaStateManager.instance().getContextSpec();
		if (!spec) {
			this.#mediaPanel.openPicker([]);
			return;
		}
		this.#enumerating = true;
		try {
			const items =
				kind === "image"
					? (await enumerateImageCandidates(spec.modelRegistry, undefined, spec.sessionId)).map(
							c => `${c.provider}${c.modelId ? ` — ${c.modelId}` : ""}`,
						)
					: (await enumerateVideoCandidates(spec.modelRegistry, spec.sessionId)).map(
							c => `${c.provider} — ${c.modelId}`,
						);
			this.#mediaPanel.openPicker(items);
		} catch {
			// Enumeration is best-effort; keep the studio usable without a picker.
		} finally {
			this.#enumerating = false;
		}
	}

	/** Resolve a picked label back to provider/model and store it in the manager. */
	#applyModelPick(label: string | undefined): void {
		const kind = this.#mediaPanel.getMode();
		const spec = MediaStateManager.instance().getContextSpec();
		if (spec?.modelRegistry) {
			try {
				// Re-enumerate cheaply is wasteful; instead resolve from label via
				// the same candidates used to build it — re-run enumeration sync-free
				// is impossible, so cache was avoided: simplest is re-enumerate once.
				void Promise.resolve().then(async () => {
					const candidates =
						kind === "image"
							? await enumerateImageCandidates(spec.modelRegistry, undefined, spec.sessionId)
							: await enumerateVideoCandidates(spec.modelRegistry, spec.sessionId);
					const match = candidates.find(c => c.provider + (c.modelId ? ` — ${c.modelId}` : "") === label);
					if (match) {
						MediaStateManager.instance().setModelPick(kind, {
							provider: match.provider,
							model: match.modelId ?? match.provider,
						});
					} else {
						MediaStateManager.instance().setModelPick(kind, undefined);
					}
					this.onRequestRender?.();
				});
			} catch {
				// Keep last pick on failure.
			}
		}
	}

	/** Load an image preview for the selected gallery item (async, cached). */
	#loadPreview(item: MediaGalleryItem | undefined): void {
		if (!item || item.kind !== "image") {
			this.#previewImage = undefined;
			this.#previewPath = undefined;
			return;
		}
		if (item.path === this.#previewPath) return;
		this.#previewPath = item.path;
		this.#previewImage = undefined;
		const ext = item.path.slice(item.path.lastIndexOf(".")).toLowerCase();
		const mime = EXT_MIME[ext] ?? "image/png";
		try {
			const buf = fs.readFileSync(item.path);
			const b64 = buf.toString("base64");
			this.#previewImage = new Image(
				b64,
				mime,
				{
					fallbackColor: (s: string) => theme.fg("toolOutput", s),
				},
				{ maxWidthCells: 60, maxHeightCells: 20 },
			);
			this.onRequestRender?.();
		} catch {
			// File may have been deleted; leave preview empty.
		}
	}

	/**
	 * Full-terminal frame exactly like /hub: the content (media panel with its
	 * own header/footer) renders at the top of a viewport that fills
	 * process.stdout.rows, so `/studio` takes over the whole window.
	 */
	override render(width: number): string[] {
		const termHeight = process.stdout.rows || 40;
		const viewport: string[] = [];

		// Top border + header
		viewport.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		viewport.push(
			`  ${theme.bold(theme.fg("accent", "✦ Aery Media Studio"))}  ${theme.fg("dim", "— image & video generation")}`,
		);
		viewport.push("");

		// Media panel (prompt, queue, gallery list).
		const content = this.#mediaPanel.render(width);
		for (const line of content) {
			viewport.push(line);
		}

		// Image preview: render the selected gallery image inline (Kitty/sixel/iTerm2).
		if (this.#previewImage) {
			viewport.push("");
			viewport.push(`  ${theme.bold("  Preview")}`);
			const imgLines = this.#previewImage.render(width);
			for (const line of imgLines) {
				viewport.push(line);
			}
		}

		// Video player (if active).
		if (this.#videoPlayer) {
			viewport.push("");
			const playerLines = this.#videoPlayer.render(width);
			for (const line of playerLines) {
				viewport.push(line);
			}
		}

		// Pad to full terminal height.
		const padY = Math.max(0, termHeight - viewport.length - BOTTOM_CHROME);
		for (let i = 0; i < padY; i++) {
			viewport.push("");
		}

		// Footer chrome
		viewport.push("");
		viewport.push(
			theme.fg(
				"dim",
				"  [tab] Image/Video · [enter] render · [←/→] gallery · [enter on 🎬] play · [esc / q / F2] close",
			),
		);
		viewport.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		return viewport;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			data === "\x1b" ||
			data === "\x1b\x1b" ||
			matchesKey(data, "q") ||
			matchesKey(data, "f2")
		) {
			this.onClose?.();
			return;
		}

		// Video player alt-chords take priority over everything but close.
		const playerListener = this.#playerKeyListener;
		if (playerListener) {
			const handled = playerListener(data);
			if (handled?.consume) {
				this.onRequestRender?.();
				return;
			}
		}

		// Studio settings alt-chords (fal-style: aspect/length/res/model).
		if (matchesKey(data, "alt+a")) {
			this.#mediaPanel.getMode() === "image"
				? this.#mediaPanel.cycleImageRatio()
				: this.#mediaPanel.cycleVideoRatio();
			this.onRequestRender?.();
			return;
		}
		if (matchesKey(data, "alt+d")) {
			this.#mediaPanel.cycleVideoDuration();
			this.onRequestRender?.();
			return;
		}
		if (matchesKey(data, "alt+r")) {
			this.#mediaPanel.cycleVideoResolution();
			this.onRequestRender?.();
			return;
		}
		if (matchesKey(data, "alt+m")) {
			void this.#openModelPicker();
			this.onRequestRender?.();
			return;
		}

		// On the media studio, Tab toggles Image/Video mode.
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#mediaPanel.setMode(this.#mediaPanel.getMode() === "image" ? "video" : "image");
			this.onRequestRender?.();
			return;
		}

		this.#mediaPanel.handleMediaKey(data);
		this.#mediaPanel.handleTextInput(data);
		this.onRequestRender?.();
	}
}
