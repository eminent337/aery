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

import { Container, matchesKey, Spacer, Text } from "@aryee337/aery-tui";
import { theme } from "../../theme/theme.js";
import { DynamicBorder } from "../dynamic-border.js";
import { VideoPlayer, type VideoPlayerTheme } from "../video-player.js";
import { MediaStateManager } from "./media-state.js";
import { StudioMediaPanel } from "./studio-media-panel.js";

export class AeryMediaStudioOverlay extends Container {
	#mediaPanel: StudioMediaPanel;
	#mediaUnsubscribe?: () => void;
	#videoPlayer?: VideoPlayer;
	#playerKeyListener?: (data: string) => { consume?: boolean } | undefined;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor() {
		super();
		const mediaManager = MediaStateManager.instance();
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
		});

		this.#mediaUnsubscribe = mediaManager.subscribe(() => {
			this.#mediaPanel.updateSnapshot(MediaStateManager.instance().getSnapshot());
		});

		this.#buildLayout();
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

	#buildLayout(): void {
		this.clear();
		this.addChild(new DynamicBorder());

		const header = `  ${theme.bold(theme.fg("accent", "✦ Aery Media Studio"))}  ${theme.fg("dim", "— image & video generation")}`;
		this.addChild(new Text(header, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#mediaPanel);
		this.addChild(new Spacer(1));
		const footer = theme.fg(
			"dim",
			"  [tab] Image/Video · [enter] render · [←/→] gallery · [enter on 🎬] play · [esc / q / F2] close",
		);
		this.addChild(new Text(footer, 0, 0));
		this.addChild(new DynamicBorder());

		this.onRequestRender?.();
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
