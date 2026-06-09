/**
 * ToolCard — tool execution display with heavy-bar design.
 *
 *  ▄▄ ◐ read_file ━━━━━━━━━━━━━━━━━━━━━━━━━━ 0.3s ▄
 *    /path/to/file.ts
 *  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 */

import type { SymbolTheme } from "../symbols.js";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

const CYAN = "\x1b[38;5;80m";
const GREEN = "\x1b[38;5;114m";
const RED = "\x1b[38;5;203m";
const DIM = "\x1b[38;5;245m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const DEFAULT_SPINNER = ["◐", "◓", "◑", "◒"];
let spinnerIdx = 0;

export type ToolStatus = "running" | "done" | "error" | "pending";

export interface ToolCardOptions {
	tool: string;
	status: ToolStatus;
	badge?: string;
	collapsed?: boolean;
}

export class ToolCard implements Component {
	#opts: ToolCardOptions;
	#content: string[] = [];
	#cache: string[] | null = null;
	#cacheWidth = -1;
	#spinner: string[];

	constructor(opts: ToolCardOptions, symbols?: Pick<SymbolTheme, "spinnerFrames">) {
		this.#opts = { ...opts };
		this.#spinner = symbols?.spinnerFrames ?? DEFAULT_SPINNER;
	}

	setStatus(status: ToolStatus, badge?: string): void {
		this.#opts.status = status;
		if (badge !== undefined) this.#opts.badge = badge;
		if (status === "running") spinnerIdx = (spinnerIdx + 1) % this.#spinner.length;
		this.#cache = null;
	}

	setContent(lines: string[]): void {
		this.#content = lines;
		this.#cache = null;
	}
	setCollapsed(v: boolean): void {
		this.#opts.collapsed = v;
		this.#cache = null;
	}

	invalidate(): void {
		this.#cache = null;
		this.#cacheWidth = -1;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.#cache && this.#cacheWidth === width) return this.#cache;

		const result: string[] = [];
		const icon = this.#icon();
		const badge = this.#opts.badge ? ` ${DIM}${this.#opts.badge}${RESET} ` : "";
		const toolPart = ` ${icon} ${BOLD}${this.#opts.tool}${RESET} `;
		const toolVis = visibleWidth(` ${this.#opts.tool} `) + 4;
		const badgeVis = visibleWidth(badge);
		const fillCount = Math.max(2, width - toolVis - badgeVis - 3);

		result.push(`${CYAN}▄▄${RESET}${toolPart}${CYAN}${"━".repeat(fillCount)}${RESET}${badge}${CYAN}▄${RESET}`);

		if (!this.#opts.collapsed) {
			const cw = Math.max(1, width - 2);
			for (const line of this.#content) result.push(`  ${line.slice(0, cw)}`);
			result.push(DIM + "▀".repeat(width) + RESET);
		} else {
			result.push(DIM + "▀".repeat(width) + RESET);
		}

		this.#cache = result;
		this.#cacheWidth = width;
		return result;
	}

	#icon(): string {
		switch (this.#opts.status) {
			case "running":
				return CYAN + this.#spinner[spinnerIdx % this.#spinner.length]! + RESET;
			case "done":
				return `${GREEN}✓${RESET}`;
			case "error":
				return `${RED}✗${RESET}`;
			case "pending":
				return `${DIM}○${RESET}`;
		}
	}
}
