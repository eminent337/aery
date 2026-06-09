import type { Component } from "../tui.js";

export class ScrollBox implements Component {
	#child: Component;
	#height: number = 0;
	#scrollOffset: number = 0;
	#stickToBottom: boolean = true;
	#cachedLines: string[] = [];
	#cacheValid: boolean = false;

	#lastWidth: number = -1;

	constructor(child: Component) {
		this.#child = child;
	}

	setHeight(height: number): void {
		if (this.#height !== height) {
			this.#height = height;
			this.invalidate();
		}
	}

	get scrollOffset(): number {
		return this.#scrollOffset;
	}

	invalidate(): void {
		this.#cacheValid = false;
		this.#child.invalidate();
	}

	scrollUp(lines: number = 1): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset - lines);
		this.#stickToBottom = false;
	}

	scrollDown(lines: number = 1): void {
		this.#scrollOffset += lines;
		const maxScroll = Math.max(0, this.#cachedLines.length - this.#height);
		if (this.#scrollOffset >= maxScroll) {
			this.#scrollOffset = maxScroll;
			this.#stickToBottom = true;
		}
	}

	scrollToBottom(): void {
		this.#stickToBottom = true;
	}

	render(width: number): string[] {
		if (width <= 0 || this.#height <= 0) return [];

		if (!this.#cacheValid || this.#lastWidth !== width) {
			this.#cachedLines = this.#child.render(width);
			this.#lastWidth = width;
			this.#cacheValid = true;
		}

		const totalLines = this.#cachedLines.length;

		if (this.#stickToBottom) {
			this.#scrollOffset = Math.max(0, totalLines - this.#height);
		} else {
			// Ensure scrollOffset is within bounds
			this.#scrollOffset = Math.min(this.#scrollOffset, Math.max(0, totalLines - this.#height));
		}

		const visibleLines = this.#cachedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#height);

		// Pad with empty lines if needed
		while (visibleLines.length < this.#height) {
			visibleLines.push("");
		}

		return visibleLines;
	}
}
