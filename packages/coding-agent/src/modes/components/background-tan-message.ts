import type { TextContent } from "@aryee337/aery-ai";
import type { Component } from "@aryee337/aery-tui";
import { Box, Container, Markdown, Spacer, Text } from "@aryee337/aery-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { BackgroundTanDispatchDetails, CustomMessage } from "../../session/messages";

export class BackgroundTanMessageComponent extends Container {
	#box: Box;
	#contentComponent?: Component;
	#expanded = false;

	constructor(private readonly message: CustomMessage<BackgroundTanDispatchDetails>) {
		super();
		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, t => theme.fg("accent", t));
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#contentComponent) {
			this.removeChild(this.#contentComponent);
			this.#contentComponent = undefined;
		}

		this.removeChild(this.#box);
		this.addChild(this.#box);
		this.#box.clear();

		const label = theme.fg("customMessageLabel", theme.bold("[tan]"));
		this.#box.addChild(new Text(label, 0, 0));
		this.#box.addChild(new Spacer(1));

		const details = this.message.details;
		const infoLines = [
			`Job ID: ${details?.jobId ?? "unknown"}`,
			details?.work ? `Task: ${details.work}` : undefined,
		].filter((line): line is string => Boolean(line));

		this.#box.addChild(
			new Markdown(infoLines.join("\n"), 0, 0, getMarkdownTheme(), {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);

		if (!this.#expanded) {
			return;
		}

		const text = this.#extractText();
		if (!text) {
			return;
		}

		this.#box.addChild(new Spacer(1));
		const detailsHeader = theme.fg("customMessageLabel", theme.bold("Details"));
		this.#box.addChild(new Text(detailsHeader, 0, 0));
		this.#box.addChild(new Spacer(1));

		this.#contentComponent = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		});
		this.#box.addChild(this.#contentComponent);
	}

	#extractText(): string {
		if (typeof this.message.content === "string") {
			return this.message.content;
		}
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}
}
