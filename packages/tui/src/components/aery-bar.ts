/**
 * AeryBar — Powerline-style status bar.
 *
 *  ▓ AERY ▒░  gpt-4o  ░▒  ~/project  ░▒  $0.003  ░░░░░░░
 *
 * Fills exactly the terminal width. Accent segments use amber bg.
 */

import type { SymbolTheme } from "../symbols.js";
import type { Component } from "../tui.js";
import { padding, visibleWidth } from "../utils.js";

const BG_AMBER = "\x1b[48;5;214m";
const BG_SLATE = "\x1b[48;5;236m";
const FG_WHITE = "\x1b[97m";
const FG_DIM = "\x1b[38;5;245m";
const FG_AMBER = "\x1b[38;5;214m";
const RESET = "\x1b[0m";

export interface BarSegment {
	text: string;
	accent?: boolean;
	icon?: string;
}

const DEFAULT_SYMBOLS = {
	aeryBarStart: "▓",
	aeryBarLeft: "▒░",
	aeryBarRight: "░▒",
} satisfies Pick<SymbolTheme, "aeryBarStart" | "aeryBarLeft" | "aeryBarRight">;

export class AeryBar implements Component {
	#segments: BarSegment[] = [];
	#cache: string | null = null;
	#cacheWidth = -1;
	#symbols: Pick<SymbolTheme, "aeryBarStart" | "aeryBarLeft" | "aeryBarRight">;

	constructor(symbols?: Pick<SymbolTheme, "aeryBarStart" | "aeryBarLeft" | "aeryBarRight">) {
		this.#symbols = symbols ?? DEFAULT_SYMBOLS;
	}

	setSegments(segments: BarSegment[]): void {
		this.#segments = segments;
		this.#cache = null;
	}

	invalidate(): void {
		this.#cache = null;
		this.#cacheWidth = -1;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.#cache && this.#cacheWidth === width) return [this.#cache];
		const line = this.#build(width);
		this.#cache = line;
		this.#cacheWidth = width;
		return [line];
	}

	#build(width: number): string {
		if (this.#segments.length === 0) {
			return BG_SLATE + padding(width) + RESET;
		}
		const parts: string[] = [];
		let usedWidth = 0;

		for (let i = 0; i < this.#segments.length; i++) {
			const seg = this.#segments[i]!;
			const label = (seg.icon ? `${seg.icon} ` : "") + seg.text;
			const paddedLabel = ` ${label} `;

			if (i === 0) {
				const sep = this.#symbols.aeryBarStart;
				parts.push(BG_AMBER + FG_DIM + sep + RESET);
				usedWidth += visibleWidth(sep);
			} else {
				const sep = ` ${this.#symbols.aeryBarLeft} `;
				parts.push(BG_SLATE + FG_DIM + sep + RESET);
				usedWidth += visibleWidth(sep);
			}

			if (seg.accent) {
				parts.push(BG_AMBER + FG_WHITE + paddedLabel + RESET);
			} else {
				parts.push(BG_SLATE + FG_DIM + paddedLabel + RESET);
			}
			usedWidth += visibleWidth(paddedLabel);
		}

		// Trailing fade + fill
		const trail = ` ${this.#symbols.aeryBarRight}`;
		parts.push(BG_SLATE + FG_DIM + trail + RESET);
		usedWidth += visibleWidth(trail);

		const remaining = Math.max(0, width - usedWidth);
		parts.push(BG_SLATE + padding(remaining) + RESET);

		return parts.join("");
	}
}
