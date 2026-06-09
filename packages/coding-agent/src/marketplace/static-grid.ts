import type { Component } from "@aryee337/aery-tui";
import { padding, visibleWidth } from "@aryee337/aery-tui";
import chalk from "chalk";
import type { Pack } from "./types";

const TIER_BADGE: Record<string, string> = {
	core: "⚙",
	verified: "✦",
	community: "◆",
};

export class MarketplaceStaticGrid implements Component {
	#items: { name: string; pack: Pack; installed: boolean }[] = [];

	invalidate(): void {}

	constructor(packs: { name: string; pack: Pack; installed: boolean }[]) {
		this.#items = packs;
	}

	render(width: number): string[] {
		const out: string[] = [];
		const cols = 2;
		const colWidth = Math.floor((width - 8) / cols);

		for (let i = 0; i < this.#items.length; i += cols) {
			const rowItems = this.#items.slice(i, i + cols);

			// Card top border
			let topStr = "  ";
			for (let j = 0; j < rowItems.length; j++) {
				topStr += chalk.dim(`╭${"─".repeat(colWidth - 2)}╮`);
				if (j < rowItems.length - 1) topStr += "  ";
			}
			out.push(topStr);

			// Card title line
			let titleStr = "  ";
			for (let j = 0; j < rowItems.length; j++) {
				const item = rowItems[j]!;
				const badge = TIER_BADGE[item.pack.tier ?? "community"] ?? "◆";
				const nameTxt = `${badge} ${item.name} ${item.installed ? chalk.green("✓") : ""}`;

				const padLen = colWidth - 4 - visibleWidth(nameTxt);
				const paddedName = ` ${chalk.white(nameTxt)}${padding(Math.max(0, padLen))} `;
				titleStr += chalk.dim("│") + paddedName + chalk.dim("│");
				if (j < rowItems.length - 1) titleStr += "  ";
			}
			out.push(titleStr);

			// Card desc line
			let descStr = "  ";
			for (let j = 0; j < rowItems.length; j++) {
				const item = rowItems[j]!;
				let desc = item.pack.description ?? "";
				if (desc.length > colWidth - 6) {
					desc = `${desc.substring(0, colWidth - 7)}…`;
				}
				const padLen = colWidth - 4 - visibleWidth(desc);
				const paddedDesc = ` ${chalk.gray(desc)}${padding(Math.max(0, padLen))} `;
				descStr += chalk.dim("│") + paddedDesc + chalk.dim("│");
				if (j < rowItems.length - 1) descStr += "  ";
			}
			out.push(descStr);

			// Card bottom border
			let botStr = "  ";
			for (let j = 0; j < rowItems.length; j++) {
				botStr += chalk.dim(`╰${"─".repeat(colWidth - 2)}╯`);
				if (j < rowItems.length - 1) botStr += "  ";
			}
			out.push(botStr);
		}

		return out;
	}
}
