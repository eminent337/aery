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

import { Container, matchesKey } from "@aryee337/aery-tui";
import { theme } from "../../theme/theme.js";
import { VideoPlayer, type VideoPlayerTheme } from "../video-player.js";
import { MediaStateManager } from "./media-state.js";
import { StudioMediaPanel } from "./studio-media-panel.js";

/** Top chrome lines: top border, header, blank. */
const TOP_CHROME = 3;
/** Bottom chrome lines: blank, footer, bottom border. */
const BOTTOM_CHROME = 3;
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
			this.onRequestRender?.();
		});

		this.onRequestRender?.();
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

	/**
	 * Full-terminal frame exactly like /hub: the content (media panel with its
	 * own header/footer) renders at the top of a viewport that fills
	 * process.stdout.rows, so `/studio` takes over the whole window.
	 */
	override render(width: number): string[] {
		const termHeight = process.stdout.rows || 40;
		const padY = Math.max(0, termHeight - TOP_CHROME - BOTTOM_CHROME);
		const viewport: string[] = [];

		// Top border + header
		viewport.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		viewport.push(
			`  ${theme.bold(theme.fg("accent", "✦ Aery Media Studio"))}  ${theme.fg("dim", "— image & video generation")}`,
		);
		viewport.push("");

		// Media panel (content) with blank padding below to reach full height.
		const content = this.#mediaPanel.render(width);
		for (let i = 0; i < padY; i++) {
			viewport.push(content[i] ?? " ".repeat(Math.max(0, width)));
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
