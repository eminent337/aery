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
		const w = Math.max(70, width);
		const innerW = w - 4;
		const snap = MediaStateManager.instance().getSnapshot();
		const mode = this.#mediaPanel.getMode();
		const gallery = snap.gallery;
		const selected = gallery[snap.selectedIndex];

		const viewport: string[] = [];

		// 1. Top Header Bar (with styled badges & settings)
		const imageTab = mode === "image" ? "[● Image]" : "(  Image )";
		const videoTab = mode === "video" ? "[● Video]" : "(  Video )";
		const modelText = "model: auto (best free)";
		const settingsText =
			mode === "image" ? `${imageTab}  ${videoTab}   ${modelText}` : `${imageTab}  ${videoTab}   ${modelText}`;

		viewport.push(
			theme.fg(
				"border",
				`╭─ ${theme.bold(theme.fg("accent", "✦ Aery Media Studio"))} ${theme.fg("border", "─".repeat(Math.max(0, w - 28)))}╮`,
			),
		);
		const headerContent = `  ${theme.bold(theme.fg("accent", "✦ Generate"))}   ${settingsText}`;
		const padHead = Math.max(0, w - 2 - headerContent.replace(/\u001b\[[0-9;]*m/g, "").length);
		viewport.push(theme.fg("border", "│") + headerContent + " ".repeat(padHead) + theme.fg("border", "│"));
		viewport.push(theme.fg("border", `├${"─".repeat(w - 2)}┤`));

		// 2. Hero Viewport (Large centerpiece taking primary visual weight)
		if (this.#videoPlayer) {
			viewport.push(
				theme.fg(
					"border",
					`│ ${theme.bold(theme.fg("accent", "🎬 Video Player"))}${" ".repeat(Math.max(0, w - 18))}│`,
				),
			);
			const playerLines = this.#videoPlayer.render(innerW);
			for (const l of playerLines) {
				const cleanLen = l.replace(/\u001b\[[0-9;]*m/g, "").length;
				viewport.push(
					theme.fg("border", "│ ") + l + " ".repeat(Math.max(0, innerW - cleanLen)) + theme.fg("border", " │"),
				);
			}
		} else if (this.#previewImage) {
			viewport.push(
				theme.fg(
					"border",
					`│ ${theme.bold(theme.fg("accent", "🖼 Hero Preview"))}${" ".repeat(Math.max(0, w - 18))}│`,
				),
			);
			const imgLines = this.#previewImage.render(innerW);
			for (const l of imgLines) {
				const cleanLen = l.replace(/\u001b\[[0-9;]*m/g, "").length;
				viewport.push(
					theme.fg("border", "│ ") + l + " ".repeat(Math.max(0, innerW - cleanLen)) + theme.fg("border", " │"),
				);
			}
		} else if (selected && selected.kind === "video") {
			viewport.push(
				theme.fg(
					"border",
					`│ ${theme.bold(theme.fg("accent", "🎬 Video Ready"))}${" ".repeat(Math.max(0, w - 17))}│`,
				),
			);
			viewport.push(theme.fg("border", `│${" ".repeat(w - 2)}│`));
			const playPrompt = `       ▶ Press [Enter] to play video in terminal player`;
			viewport.push(
				theme.fg("border", "│") +
					theme.bold(theme.fg("success", playPrompt)) +
					" ".repeat(Math.max(0, w - 2 - playPrompt.length)) +
					theme.fg("border", "│"),
			);
			viewport.push(theme.fg("border", `│${" ".repeat(w - 2)}│`));
		} else {
			// Sleek Hero Empty Canvas
			viewport.push(
				theme.fg(
					"border",
					`│ ${theme.bold(theme.fg("muted", "✦ Studio Canvas"))}${" ".repeat(Math.max(0, w - 19))}│`,
				),
			);
			viewport.push(theme.fg("border", `│${" ".repeat(w - 2)}│`));
			const welcome1 = "                 ✦ AERY TERMINAL MEDIA STUDIO ✦";
			const welcome2 = "      Next-generation AI image & video generation in your terminal";
			const welcome3 = "        Type a prompt below and press [Enter] to generate media";
			viewport.push(
				theme.fg("border", "│") +
					theme.bold(theme.fg("accent", welcome1)) +
					" ".repeat(Math.max(0, w - 2 - welcome1.length)) +
					theme.fg("border", "│"),
			);
			viewport.push(
				theme.fg("border", "│") +
					theme.fg("muted", welcome2) +
					" ".repeat(Math.max(0, w - 2 - welcome2.length)) +
					theme.fg("border", "│"),
			);
			viewport.push(
				theme.fg("border", "│") +
					theme.fg("dim", welcome3) +
					" ".repeat(Math.max(0, w - 2 - welcome3.length)) +
					theme.fg("border", "│"),
			);
			viewport.push(theme.fg("border", `│${" ".repeat(w - 2)}│`));
		}

		// Selected Media Metadata Pill (if gallery has items)
		if (selected) {
			viewport.push(theme.fg("border", `├${"─".repeat(w - 2)}┤`));
			const icon = selected.kind === "image" ? "🖼" : "🎬";
			const metaStr = ` ${icon} "${selected.prompt.slice(0, 42)}"  ·  ${selected.provider}/${selected.model}  [${snap.selectedIndex + 1}/${gallery.length}]`;
			const metaCleanLen = metaStr.replace(/\u001b\[[0-9;]*m/g, "").length;
			viewport.push(
				theme.fg("border", "│") +
					theme.fg("accent", metaStr) +
					" ".repeat(Math.max(0, w - 2 - metaCleanLen)) +
					theme.fg("border", "│"),
			);
		}

		// 3. Queue / Activity Ticker (if jobs running or queued)
		const activeJob = snap.jobs.find(j => j.status === "running" || j.status === "queued");
		if (activeJob) {
			viewport.push(theme.fg("border", `├${"─".repeat(w - 2)}┤`));
			const qIcon =
				activeJob.status === "running" ? theme.fg("warning", "⚡ Rendering") : theme.fg("muted", "⏳ Queued");
			const qText = ` ${qIcon} "${activeJob.subject.slice(0, 36)}" — ${activeJob.note ?? activeJob.status}`;
			const qCleanLen = qText.replace(/\u001b\[[0-9;]*m/g, "").length;
			viewport.push(
				theme.fg("border", "│") + qText + " ".repeat(Math.max(0, w - 2 - qCleanLen)) + theme.fg("border", "│"),
			);
		}

		// 4. Model Picker Modal or Prompt Dock
		if (this.#mediaPanel.isPickerOpen) {
			viewport.push(theme.fg("border", `├─ ${theme.bold("Pick Model")} ${"─".repeat(Math.max(0, w - 16))}┤`));
			const promptLines = this.#mediaPanel.render(innerW);
			for (const pl of promptLines) {
				const cleanLen = pl.replace(/\u001b\[[0-9;]*m/g, "").length;
				viewport.push(
					theme.fg("border", "│ ") + pl + " ".repeat(Math.max(0, innerW - cleanLen)) + theme.fg("border", " │"),
				);
			}
		} else {
			viewport.push(theme.fg("border", `├─ ${theme.bold("Prompt")} ${"─".repeat(Math.max(0, w - 12))}┤`));
			const promptVal = `  prompt > ${this.#mediaPanel.getPrompt()}▊`;
			const pCleanLen = promptVal.length;
			viewport.push(
				theme.fg("border", "│") +
					theme.bold(promptVal) +
					" ".repeat(Math.max(0, w - 2 - pCleanLen)) +
					theme.fg("border", "│"),
			);
		}

		// 5. Dock Controls / Keybinding Bar
		viewport.push(theme.fg("border", `├${"─".repeat(w - 2)}┤`));
		const helpBar =
			"  [tab] mode · [alt+a] aspect · [alt+d] length · [alt+m] model · [←/→] gallery · [enter] render · [esc] close";
		const hCleanLen = helpBar.length;
		viewport.push(
			theme.fg("border", "│") +
				theme.fg("muted", helpBar) +
				" ".repeat(Math.max(0, w - 2 - hCleanLen)) +
				theme.fg("border", "│"),
		);
		viewport.push(theme.fg("border", `╰${"─".repeat(w - 2)}╯`));

		// Fill/Pad to exactly termHeight so overlay takes full window
		while (viewport.length < termHeight) {
			// Insert extra canvas rows inside the Hero section (before prompt)
			const insertIdx = 3;
			viewport.splice(insertIdx, 0, theme.fg("border", `│${" ".repeat(w - 2)}│`));
		}
		if (viewport.length > termHeight) {
			viewport.length = termHeight;
		}

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
