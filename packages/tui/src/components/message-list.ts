/**
 * MessageList — chat history renderer with colored role left-bars.
 *
 *  ▎ You          ← amber bar
 *  ▎ Hello there
 *
 *  ▎ Aery         ← cyan bar
 *  ▎ Hi! How can I help?
 */
import type { Component } from "../tui.js";
import { wrapTextWithAnsi } from "../utils.js";

const AMBER = "\x1b[38;5;214m";
const CYAN = "\x1b[38;5;80m";
const DIM = "\x1b[38;5;245m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const BAR = "▎";

const LABELS: Record<string, string> = {
	user: "You",
	assistant: "Aery",
	system: "System",
	tool: "Tool",
};

export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
}

export class MessageList implements Component {
	#messages: ChatMessage[] = [];
	#cache: string[] | null = null;
	#cacheWidth = -1;

	appendMessage(msg: ChatMessage): void {
		this.#messages.push({ ...msg });
		this.#cache = null;
	}

	appendChunk(text: string): void {
		const last = this.#messages[this.#messages.length - 1];
		if (last?.role === "assistant") {
			last.content += text;
			this.#cache = null;
		}
	}

	updateLast(content: string): void {
		const last = this.#messages[this.#messages.length - 1];
		if (last) {
			last.content = content;
			this.#cache = null;
		}
	}

	clear(): void {
		this.#messages = [];
		this.#cache = null;
	}

	invalidate(): void {
		this.#cache = null;
		this.#cacheWidth = -1;
	}

	render(width: number): string[] {
		if (width <= 0 || this.#messages.length === 0) return [];
		if (this.#cache && this.#cacheWidth === width) return this.#cache;

		const lines: string[] = [];
		const contentWidth = Math.max(1, width - 3);

		for (let i = 0; i < this.#messages.length; i++) {
			const msg = this.#messages[i]!;
			const color = msg.role === "user" ? AMBER : msg.role === "assistant" ? CYAN : DIM;
			const bar = `${color + BAR + RESET} `;

			lines.push(bar + BOLD + color + (LABELS[msg.role] ?? msg.role) + RESET);
			for (const line of wrapTextWithAnsi(msg.content || "", contentWidth)) {
				lines.push(bar + line);
			}
			if (i < this.#messages.length - 1) lines.push("");
		}

		this.#cache = lines;
		this.#cacheWidth = width;
		return lines;
	}
}
