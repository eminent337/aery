import type { Component, TUI } from "@aryee337/aery-tui";
import { Box, FlexBox, FlexContainer, padding, ScrollBox, Text, visibleWidth } from "@aryee337/aery-tui";
import chalk from "chalk";
import type { InstalledPack, Pack } from "./types";

const TIER_BADGE: Record<string, string> = {
	core: "⚙",
	verified: "✦",
	community: "◆",
};

class MarketplaceCard implements Component {
	#title: string;
	#desc: string;
	#selected: boolean;

	constructor(title: string, desc: string, selected: boolean) {
		this.#title = title;
		this.#desc = desc;
		this.#selected = selected;
	}

	render(width: number): string[] {
		const c = this.#selected ? chalk.cyan : chalk.dim;
		const textC = this.#selected ? chalk.bold.white : chalk.white;

		const out: string[] = [];
		const topStr = c(`╭${"─".repeat(width - 2)}╮`);
		out.push(topStr);

		const padLenTitle = width - 4 - visibleWidth(this.#title);
		const titleStr = `${c("│")} ${textC(this.#title)}${padding(Math.max(0, padLenTitle))} ${c("│")}`;
		out.push(titleStr);

		let desc = this.#desc;
		if (desc.length > width - 6) {
			desc = `${desc.substring(0, width - 7)}…`;
		}
		const padLenDesc = width - 4 - visibleWidth(desc);
		const descStr = `${c("│")} ${chalk.gray(desc)}${padding(Math.max(0, padLenDesc))} ${c("│")}`;
		out.push(descStr);

		const botStr = c(`╰${"─".repeat(width - 2)}╯`);
		out.push(botStr);

		return out;
	}

	invalidate(): void {}
}

export class MarketplaceGrid implements Component {
	#items: { name: string; pack: Pack | null; installed: boolean; isAction: boolean; formattedValue: string }[] = [];
	#selectedIndex = 0;
	#done: (result: string | undefined) => void;
	#tui: TUI;
	#scrollBox: ScrollBox;
	#layout: FlexContainer;

	constructor(
		tui: TUI,
		availablePacks: [string, Pack][],
		installedPacks: InstalledPack[],
		done: (result: string | undefined) => void,
	) {
		this.#tui = tui;
		this.#done = done;

		for (const [name, pack] of availablePacks) {
			const isInst = !!installedPacks.find(p => p.name === name);
			const tierBadge = TIER_BADGE[pack.tier ?? "community"] ?? "◆";
			this.#items.push({
				name,
				pack,
				installed: isInst,
				isAction: false,
				formattedValue: `${tierBadge} ${name}`,
			});
		}

		this.#items.push({
			name: "List installed",
			pack: null,
			installed: false,
			isAction: true,
			formattedValue: "📋 List installed",
		});
		this.#items.push({
			name: "Update all",
			pack: null,
			installed: false,
			isAction: true,
			formattedValue: "🔄 Update all",
		});

		// Build Layout
		this.#layout = new FlexContainer(() => this.#tui.terminal.rows);
		const contentContainer = new FlexContainer(() => {
			// Compute height of all content to allow ScrollBox to scroll
			// 4 lines header + (rows * 4 lines per card) + 3 lines footer
			const rows = Math.ceil(this.#items.length / 2);
			return 4 + rows * 4 + 3;
		});

		this.#scrollBox = new ScrollBox(contentContainer);
		this.#layout.addChild(this.#scrollBox, 1);
	}

	#buildContent(): Component {
		const root = new FlexContainer(() => {
			const rows = Math.ceil(this.#items.length / 2);
			return 4 + rows * 4 + 3;
		});

		const header = new FlexBox({ direction: "column" });
		header.addItem(new Box(0, 1), { fixed: 1 });
		header.addItem(new Text(`  ${chalk.bold.cyan(" 🛒  AERY SOVEREIGN MARKETPLACE ")}`), { fixed: 1 });
		header.addItem(new Text(`  ${chalk.dim("⚙ core  ✦ verified  ◆ community  ✓ installed")}`), { fixed: 1 });
		header.addItem(new Box(0, 1), { fixed: 1 });
		root.addChild(header, 0, 4);

		const cols = 2;
		for (let i = 0; i < this.#items.length; i += cols) {
			const rowItems = this.#items.slice(i, i + cols);
			const row = new FlexBox({ direction: "row", gap: 2 });

			// Leading indent
			row.addItem(new Box(2, 4), { fixed: 2 });

			for (let j = 0; j < cols; j++) {
				const item = rowItems[j];
				if (item) {
					const isSel = i + j === this.#selectedIndex;
					let nameTxt = item.name;
					const descTxt = item.pack?.description ?? "";
					if (item.pack) {
						const badge = TIER_BADGE[item.pack.tier ?? "community"] ?? "◆";
						nameTxt = `${badge} ${item.name} ${item.installed ? chalk.green("✓") : ""}`;
					} else {
						nameTxt = item.formattedValue;
					}

					row.addItem(new MarketplaceCard(nameTxt, descTxt, isSel), { grow: 1 });
				} else {
					row.addItem(new Box(0, 4), { grow: 1 }); // Empty space
				}
			}

			// Trailing indent
			row.addItem(new Box(2, 4), { fixed: 2 });

			root.addChild(row, 0, 4);
		}

		const footer = new FlexBox({ direction: "column" });
		footer.addItem(new Box(0, 1), { fixed: 1 });
		footer.addItem(new Text(`  ${chalk.dim("Use ↑/↓/←/→ to navigate, Enter to select, Esc to cancel.")}`), {
			fixed: 1,
		});
		footer.addItem(new Box(0, 1), { fixed: 1 });
		root.addChild(footer, 0, 3);

		return root;
	}

	handleInput(key: string): boolean {
		if (key === "up" || key === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 2);
			this.#scrollBox.scrollUp(4); // Scroll a card height
			this.#tui.requestRender();
			return true;
		}
		if (key === "down" || key === "j") {
			this.#selectedIndex = Math.min(this.#items.length - 1, this.#selectedIndex + 2);
			this.#scrollBox.scrollDown(4);
			this.#tui.requestRender();
			return true;
		}
		if (key === "left" || key === "h") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#tui.requestRender();
			return true;
		}
		if (key === "right" || key === "l") {
			this.#selectedIndex = Math.min(this.#items.length - 1, this.#selectedIndex + 1);
			this.#tui.requestRender();
			return true;
		}
		if (key === "return" || key === "enter") {
			this.#done(this.#items[this.#selectedIndex]?.formattedValue);
			return true;
		}
		if (key === "escape" || key === "q") {
			this.#done(undefined);
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		// Rebuild content layout on render so we highlight correct items
		this.#layout.clear();
		const contentContainer = this.#buildContent();
		// Retain scroll offset
		const prevScroll = this.#scrollBox.scrollOffset ?? 0;
		this.#scrollBox = new ScrollBox(contentContainer);
		// Restore offset (sneaky cast because it's private, but we can just use scrollDown)
		if (prevScroll > 0) this.#scrollBox.scrollDown(prevScroll);

		this.#layout.addChild(this.#scrollBox, 1);

		return this.#layout.render(width);
	}

	cleanup(): void {}
	invalidate(): void {}
}
