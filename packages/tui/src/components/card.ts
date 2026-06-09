/**
 * Card — styled bordered container for tool execution output.
 * Renders a box with rounded corners, optional title bar, and content.
 */

import type { SymbolTheme } from "../symbols.js";
import type { Component } from "../tui.js";
import { padding, visibleWidth } from "../utils.js";

export interface CardOptions {
	title?: string;
	badge?: string;
	icon?: string;
	bg?: string;
	borderColor?: string;
	collapsed?: boolean;
}

const DEFAULT_BOX = { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" };

export class Card implements Component {
	children: Component[] = [];
	#options: CardOptions;
	#cacheLines: string[] | null = null;
	#cacheWidth = -1;
	#cacheChildren = 0;
	#box: SymbolTheme["boxRound"];

	constructor(options: CardOptions = {}, symbols?: Pick<SymbolTheme, "boxRound">) {
		this.#options = options;
		this.#box = symbols?.boxRound ?? DEFAULT_BOX;
	}

	addChild(child: Component): this {
		this.children.push(child);
		this.#invalidate();
		return this;
	}

	invalidate(): void {
		this.#cacheLines = null;
		this.#cacheWidth = -1;
		for (const c of this.children) c.invalidate?.();
	}

	#invalidate(): void {
		this.#cacheLines = null;
		this.#cacheWidth = -1;
	}

	render(width: number): string[] {
		if (this.#cacheLines && this.#cacheWidth === width && this.#cacheChildren === this.children.length)
			return this.#cacheLines;

		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [];
		for (const child of this.children) lines.push(...child.render(innerWidth));

		const opts = this.#options;
		const result: string[] = [];
		const { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br, horizontal: h, vertical: v } = this.#box;
		const colorFn = opts.borderColor ? (s: string) => `\x1b[38;2;138;190;183m${s}\x1b[0m` : (s: string) => s;

		const titleStr = opts.icon ? `${opts.icon} ${opts.title ?? ""}` : (opts.title ?? "");
		const badgeStr = opts.badge ?? "";
		const titleSection = titleStr ? ` ${titleStr} ` : "";
		const badgeSection = badgeStr ? ` ${badgeStr} ` : "";
		const available = width - 2;
		const titleWidth = visibleWidth(titleSection);
		const badgeWidth = visibleWidth(badgeSection);
		const betweenDashes = Math.max(0, available - titleWidth - badgeWidth);

		result.push(
			colorFn(
				tl +
					h.repeat(Math.max(1, Math.floor(betweenDashes / 2))) +
					titleSection +
					h.repeat(Math.max(1, betweenDashes - Math.floor(betweenDashes / 2))) +
					badgeSection +
					tr,
			),
		);

		if (opts.collapsed) {
			result.push(colorFn(bl + h.repeat(width - 2) + br));
		} else {
			for (const line of lines) {
				const visLen = visibleWidth(line);
				const pad = Math.max(0, innerWidth - visLen);
				result.push(`${colorFn(v)} ${line}${padding(pad)} ${colorFn(v)}`);
			}
			result.push(colorFn(bl + h.repeat(width - 2) + br));
		}

		this.#cacheChildren = this.children.length;
		this.#cacheLines = result;
		this.#cacheWidth = width;
		return result;
	}
}
