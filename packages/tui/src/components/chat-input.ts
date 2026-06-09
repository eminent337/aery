/**
 * ChatInput — amber-glyph prompt wrapper around the existing Input component.
 *
 *  ─────────────────────────────────────────
 *  ❯ type your message here█
 */

import type { SymbolTheme } from "../symbols.js";
import type { Component, Focusable } from "../tui.js";
import { padding, visibleWidth } from "../utils.js";
import { Input } from "./input.js";

const AMBER = "\x1b[38;5;214m";
const DIM = "\x1b[38;5;245m";
const RESET = "\x1b[0m";

const DEFAULT_CURSOR = "❯";

export class ChatInput implements Component, Focusable {
	#input: Input;
	#cursor: string;
	focused = false;

	constructor(symbols?: Pick<SymbolTheme, "cursor">) {
		this.#input = new Input();
		this.#input.prompt = "";
		this.#cursor = symbols?.cursor ?? DEFAULT_CURSOR;
	}

	get value(): string {
		return this.#input.getValue();
	}
	clear(): void {
		this.#input.setValue("");
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}

	set onSubmit(cb: ((value: string) => void) | undefined) {
		this.#input.onSubmit = cb;
	}
	get onSubmit(): ((value: string) => void) | undefined {
		return this.#input.onSubmit;
	}

	invalidate(): void {
		this.#input.invalidate?.();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const sep = DIM + "─".repeat(width) + RESET;
		const glyph = `${AMBER + this.#cursor + RESET} `;
		const glyphVis = visibleWidth(`${this.#cursor} `);
		const inputWidth = Math.max(1, width - glyphVis);
		const inputLine = this.#input.render(inputWidth)[0] ?? padding(inputWidth);
		return [sep, glyph + inputLine];
	}
}
