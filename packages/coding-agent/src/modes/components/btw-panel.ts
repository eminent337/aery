import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@aryee337/aery-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#closed = false;
	#scrollOffset = 0;
	#maxContentLines = 14;
	#lastTotalContentLines = 0;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#rebuild();
	}

	getAnswer(): string {
		return this.#answer;
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
	}

	scrollBy(delta: number): boolean {
		if (this.#closed) return false;
		const totalLines = this.totalContentLines;
		const maxOffset = Math.max(0, totalLines - this.#maxContentLines);
		if (maxOffset <= 0) return false;
		const prev = this.#scrollOffset;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset + delta, maxOffset));
		if (this.#scrollOffset !== prev) {
			this.#rebuild();
		}
		return true;
	}

	canScroll(): boolean {
		return this.totalContentLines > this.#maxContentLines;
	}

	get scrollOffset(): number {
		return this.#scrollOffset;
	}

	get maxContentLines(): number {
		return this.#maxContentLines;
	}

	get totalContentLines(): number {
		if (this.#lastTotalContentLines > 0) return this.#lastTotalContentLines;
		const text = this.#answer.trim();
		return text ? text.split("\n").length : 0;
	}

	override render(width: number): string[] {
		width = Math.max(1, width);
		const borderTop = new DynamicBorder(str => theme.fg("dim", str)).render(width);
		const question = new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0).render(width);
		const contentComp = this.#contentComponent();
		const allContentLines = contentComp.render(width);
		this.#lastTotalContentLines = allContentLines.length;

		const isScrollable = allContentLines.length > this.#maxContentLines;
		const maxOffset = Math.max(0, allContentLines.length - this.#maxContentLines);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxOffset));

		const visibleContentLines = isScrollable
			? allContentLines.slice(this.#scrollOffset, this.#scrollOffset + this.#maxContentLines)
			: allContentLines;

		const lines: string[] = [];
		lines.push(...borderTop);
		lines.push("");
		lines.push(...question);
		lines.push("");
		lines.push(...visibleContentLines);

		if (isScrollable) {
			const startLine = this.#scrollOffset + 1;
			const endLine = Math.min(this.#scrollOffset + this.#maxContentLines, allContentLines.length);
			const scrollInfo = theme.fg("dim", `[lines ${startLine}-${endLine} of ${allContentLines.length}]`);
			lines.push(...new Text(scrollInfo, 1, 0).render(width));
		}

		lines.push("");
		lines.push(...new Text(this.#footerLine(isScrollable), 1, 0).render(width));
		lines.push("");
		lines.push(...new DynamicBorder(str => theme.fg("dim", str)).render(width));

		return lines;
	}

	#rebuild(): void {
		this.#tui.requestRender();
	}

	#footerLine(isScrollable: boolean = false): string {
		const scrollHint = isScrollable ? "↑/↓ scroll · " : "";
		switch (this.#state) {
			case "running":
				return theme.fg("muted", `${scrollHint}Esc cancel /btw`);
			case "complete":
				return theme.fg("muted", `${scrollHint}Esc dismiss · /btw promote`);
			case "aborted":
				return theme.fg("warning", `${scrollHint}${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${scrollHint}${theme.status.error} Error · Esc dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? "Unknown error")), 1, 0);
		}
		const text = replaceTabs(this.#answer).trim();
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 1, 0);
		}
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
