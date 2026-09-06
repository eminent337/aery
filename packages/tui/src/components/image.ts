import { acquireStableImageId } from "../kitty-graphics";
import {
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/**
	 * Stable identity for this image (e.g. `toolCallId:index`). Guarantees the
	 * same graphics id across component re-creations, so a transcript rebuild
	 * after a resize rebinds the already-transmitted payload instead of
	 * stacking a fresh copy in kitty's graphics store.
	 */
	imageKey?: string;
}

export class Image implements Component {
	#base64Data: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;

	#imageId?: number;

	#cachedLines?: string[];
	#cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		// A stable key keeps the graphics id — and therefore the terminal-side
		// image — alive across component re-creations (resize rebuilds, clear +
		// replay). Without a key each re-creation would get a fresh id and stack
		// a new image in the terminal's graphics store: the duplication bug.
		this.#imageId = options.imageKey ? acquireStableImageId(options.imageKey) : undefined;
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];

		if (TERMINAL.imageProtocol) {
			const result = renderImage(this.#base64Data, this.#dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: this.#options.maxHeightCells,
				imageId: this.#imageId,
				includeTransmit: this.#imageId != null,
			});

			if (result) {
				if (result.lines) {
					// Kitty placeholder path: real text-cell lines. Line 0 carries the
					// one-time-idempotent transmit (`a=t` with the stable id — re-sending
					// the same id REPLACES the stored image, never stacks) plus the
					// virtual-placement APC. Caching a frame that is later coalesced away
					// is harmless: the next emitted frame re-carries the same bytes.
					lines = result.lines;
				} else {
					// Legacy anonymous transmit-display path (non-placeholder terminals).
					// Return `rows` lines so TUI accounts for image height. First
					// (rows-1) lines are empty (TUI clears them). Last line: move cursor
					// back up, then output image sequence.
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
					lines.push(moveUp + result.sequence);
				}
			} else {
				const fallback = imageFallback(this.#mimeType, this.#dimensions, this.#options.filename);
				lines = [this.#theme.fallbackColor(fallback)];
			}
		} else {
			const fallback = imageFallback(this.#mimeType, this.#dimensions, this.#options.filename);
			lines = [this.#theme.fallbackColor(fallback)];
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;

		return lines;
	}
}
