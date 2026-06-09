import { Container, Markdown, Spacer, Text } from "@aryee337/aery-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { highlightMagicKeywords } from "../magic-keywords";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class UserMessageComponent extends Container {
	#text: string;
	#synthetic: boolean;

	constructor(text: string, synthetic = false) {
		super();
		this.#text = text;
		this.#synthetic = synthetic;
		this.updateContent();
	}

	updateContent() {
		this.clear();
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const color = this.#synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg("warning", "▎")} ${theme.bold(theme.fg("warning", "You"))}`, 0, 0));
		this.addChild(
			new Markdown(this.#text, 1, 1, getMarkdownTheme(), {
				color,
			}),
		);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateContent();
	}

	override render(width: number): string[] {
		// Reduce width to account for the left bar
		const contentWidth = Math.max(1, width - 2);
		const lines = super.render(contentWidth);
		if (lines.length === 0) {
			return lines;
		}

		const bar = `${theme.fg("warning", "▎")} `;

		// Skip the first 2 lines (Spacer + You header) from prefixing with BAR, because the header already has it, and the spacer shouldn't.
		// Actually, let's prefix everything except the Spacer (index 0) and the Header (index 1).
		for (let i = 2; i < lines.length; i++) {
			lines[i] = bar + lines[i];
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return lines;
	}
}
