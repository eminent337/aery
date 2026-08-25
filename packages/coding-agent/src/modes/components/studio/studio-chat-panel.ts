/**
 * Center Pane: Live Inter-Agent Chat Stream (IRC).
 */

import { Container, Text, Spacer } from "@aryee337/aery-tui";
import { theme } from "../../theme/theme.js";
import type { StudioChatMessage } from "./types.js";

export class StudioChatPanel extends Container {
	#messages: StudioChatMessage[] = [];

	constructor(messages: StudioChatMessage[]) {
		super();
		this.#messages = messages;
		this.#renderFeed();
	}

	updateMessages(messages: StudioChatMessage[]): void {
		this.#messages = messages;
		this.#renderFeed();
	}

	#renderFeed(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "  💬 Live Inter-Agent Communication Stream (IRC)")), 0, 0));
		this.addChild(new Spacer(1));

		if (this.#messages.length === 0) {
			this.addChild(
				new Text(
					theme.fg("muted", "  No inter-agent messages yet. Subagents will communicate here over IRC during team collaboration."),
					0,
					0,
				),
			);
			return;
		}

		// Show latest 12 messages
		const displayList = this.#messages.slice(-12);
		for (const msg of displayList) {
			const timeStr = new Date(msg.timestamp).toLocaleTimeString();
			const targetBadge = msg.isBroadcast ? theme.fg("warning", "@all") : theme.fg("accent", `@${msg.to}`);
			const header = `  ${theme.fg("dim", `[${timeStr}]`)} ${theme.bold(msg.from)} ➔ ${targetBadge}:`;
			this.addChild(new Text(header, 0, 0));
			this.addChild(new Text(`    ${msg.body}`, 0, 0));
			this.addChild(new Spacer(1));
		}
	}

	handleInput(_data: string): void {}
}
