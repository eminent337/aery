/**
 * AeryScreen — top-level screen wiring all Aery TUI components.
 *
 * Layout (terminal height = H):
 *   rows 0 .. H-4  : MessageList (tail-scrolled to fit)
 *   row  H-3       : AeryBar (1 line)
 *   rows H-2 .. H-1: ChatInput (separator + prompt)
 */
import type { BarSegment } from "./components/aery-bar.js";
import { AeryBar } from "./components/aery-bar.js";
import { ChatInput } from "./components/chat-input.js";
import type { ChatMessage } from "./components/message-list.js";
import { MessageList } from "./components/message-list.js";
import { ToolCard, type ToolCardOptions } from "./components/tool-card.js";
import type { SymbolTheme } from "./symbols.js";
import type { Component, TUI } from "./tui.js";

const BAR_HEIGHT = 1;
const INPUT_HEIGHT = 2;

export class AeryScreen {
	#tui: TUI;
	#messages: MessageList;
	#bar: AeryBar;
	#input: ChatInput;
	#toolCards: Map<string, ToolCard> = new Map();
	#symbols?: Pick<SymbolTheme, "spinnerFrames" | "aeryBarStart" | "aeryBarLeft" | "aeryBarRight">;

	constructor(
		tui: TUI,
		symbols?: Pick<SymbolTheme, "spinnerFrames" | "aeryBarStart" | "aeryBarLeft" | "aeryBarRight">,
	) {
		this.#tui = tui;
		this.#messages = new MessageList();
		this.#bar = new AeryBar(symbols);
		this.#input = new ChatInput();
		this.#symbols = symbols;

		tui.addChild(this.#makeScrollRegion());
		tui.addChild(this.#bar);
		tui.addChild(this.#input);
		tui.setFocus(this.#input);
	}

	appendMessage(msg: ChatMessage): void {
		this.#messages.appendMessage(msg);
		this.#tui.requestRender();
	}

	streamChunk(text: string): void {
		this.#messages.appendChunk(text);
		this.#tui.requestRender();
	}

	showToolCard(id: string, opts: ToolCardOptions): ToolCard {
		if (!this.#toolCards.has(id)) {
			const card = new ToolCard(opts, this.#symbols);
			this.#toolCards.set(id, card);
		}
		const card = this.#toolCards.get(id)!;
		card.setStatus(opts.status, opts.badge);
		this.#tui.requestRender();
		return card;
	}

	setBarSegments(segments: BarSegment[]): void {
		this.#bar.setSegments(segments);
		this.#tui.requestRender();
	}

	onSubmit(cb: (text: string) => void): void {
		this.#input.onSubmit = text => {
			cb(text);
			this.#input.clear();
			this.#tui.requestRender();
		};
	}

	#makeScrollRegion(): Component {
		const messages = this.#messages;
		const tui = this.#tui;
		return {
			render(width: number): string[] {
				const rows = tui.terminal.rows;
				const avail = Math.max(1, rows - BAR_HEIGHT - INPUT_HEIGHT);
				return messages.render(width).slice(-avail);
			},
			invalidate(): void {
				messages.invalidate();
			},
		};
	}
}
