import {
	type Component,
	Container,
	extractPrintableText,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	TabBar,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { getTabBarTheme } from "../../shared";
import { DynamicBorder } from "../dynamic-border";
import { SkillActionPanel } from "./skill-action-panel";
import { SkillsStateManager } from "./state";
import type { SkillItem, SkillsHubState, SkillTabId } from "./types";

class SkillSearchHeader implements Component {
	#query = "";
	#matchCount = 0;
	#active = false;

	update(query: string, matchCount: number): void {
		this.#active = true;
		this.#query = query;
		this.#matchCount = matchCount;
	}

	clear(): void {
		this.#active = false;
		this.#query = "";
		this.#matchCount = 0;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.#active) return [];

		const icon = theme.symbol("icon.search");
		const countText = this.#matchCount === 1 ? "1 match" : `${this.#matchCount} matches`;
		const rightWidth = visibleWidth(countText) + 1;
		const queryBudget = Math.max(4, width - visibleWidth(icon) - 4 - rightWidth - 1);

		let display = this.#query;
		if (visibleWidth(display) > queryBudget) {
			const chars = [...display];
			while (chars.length > 1 && visibleWidth(chars.join("")) > queryBudget - 1) {
				chars.shift();
			}
			display = `…${chars.join("")}`;
		}

		const left = ` ${theme.fg("accent", icon)} ${theme.bold(display)}${theme.fg("accent", "▌")}`;
		const right = theme.fg("dim", `${countText} `);
		const pad = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
		return [truncateToWidth(`${left}${pad}${right}`, width)];
	}
}

export class SkillsHub extends Container {
	#stateManager: SkillsStateManager;
	#state: SkillsHubState;

	#searchHeader = new SkillSearchHeader();
	#tabBar!: TabBar;
	#footer: Component[] = [];
	#selectList: SelectList | null = null;
	#activePanel: SkillActionPanel | null = null;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(
		private readonly cwd: string,
		installedSkills: readonly { name: string; description?: string; filePath?: string }[] = [],
	) {
		super();
		this.#stateManager = new SkillsStateManager(cwd, installedSkills);
		this.#state = {
			activeTab: "catalog",
			searchQuery: "",
			items: [],
			filteredItems: [],
			isLoading: true,
		};
		this.#buildShell();
		void this.#load();
	}

	#buildShell(): void {
		this.clear();

		// Top chrome: border + title
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(theme.bold(theme.fg("accent", "  ✦ Aery Skills Catalog & Hub")), 0, 0),
		);
		this.addChild(
			new Text(
				theme.fg("dim", "  Browse, install, and manage specialized agent capabilities and workflows"),
				0,
				0,
			),
		);

		// Tab bar
		const tabs = this.#buildTabs();
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const active = this.#tabBar.getActiveTab();
			this.#state.activeTab = active.id as SkillTabId;
			this.#state.searchQuery = "";
			this.#searchHeader.clear();
			this.#refreshContent();
			this.onRequestRender?.();
		};

		this.addChild(new Spacer(1));
		this.addChild(this.#tabBar);
		this.addChild(new Spacer(1));

		// Search banner
		this.addChild(this.#searchHeader);

		// Footer
		this.#footer = [
			new Spacer(1),
			new Text(
				theme.fg("dim", "  ↑/↓: navigate · Enter: details/install · Tab: switch tab · Type to search · Esc: close"),
				0,
				0,
			),
			new DynamicBorder(),
		];
		for (const child of this.#footer) {
			this.addChild(child);
		}
	}

	#buildTabs() {
		const installedCount = this.#state.items.filter(s => s.installed).length;
		return [
			{ id: "catalog", label: `✦ All Skills (${this.#state.items.length})` },
			{ id: "installed", label: `● Installed (${installedCount})` },
		];
	}

	#refreshTabCounts(): void {
		const tabs = this.#buildTabs();
		const tabIds: SkillTabId[] = ["catalog", "installed"];
		this.#tabBar.setTabs(tabs, this.#state.activeTab);
		this.#tabBar.setActiveIndex(tabIds.indexOf(this.#state.activeTab));
	}

	async #load(): Promise<void> {
		this.#setContent(() => {
			this.addChild(new Text(theme.fg("accent", "  Loading skills catalog..."), 0, 0));
		});
		this.onRequestRender?.();

		this.#state.items = await this.#stateManager.loadSkills();
		this.#state.isLoading = false;
		this.#refreshTabCounts();
		this.#refreshContent();
		this.onRequestRender?.();
	}

	#setContent(build: () => void): void {
		if (this.#selectList) {
			this.removeChild(this.#selectList);
			this.#selectList = null;
		}
		if (this.#activePanel) {
			this.removeChild(this.#activePanel);
			this.#activePanel = null;
		}

		for (const child of this.#footer) {
			this.removeChild(child);
		}
		build();
		for (const child of this.#footer) {
			this.addChild(child);
		}
	}

	#refreshContent(): void {
		this.#state.filteredItems = this.#stateManager.filterSkills(
			this.#state.items,
			this.#state.activeTab,
			this.#state.searchQuery,
		);

		if (this.#state.searchQuery) {
			this.#searchHeader.update(this.#state.searchQuery, this.#state.filteredItems.length);
		} else {
			this.#searchHeader.clear();
		}

		if (this.#state.filteredItems.length === 0) {
			this.#setContent(() => {
				this.addChild(
					new Text(
						theme.fg(
							"muted",
							this.#state.searchQuery
								? `  No skills match "${this.#state.searchQuery}"`
								: "  No skills in this tab.",
						),
						0,
						0,
					),
				);
			});
		} else {
			const selectItems: SelectItem[] = this.#state.filteredItems.map(skill => {
				const statusBadge = skill.installed
					? theme.fg("success", "● Installed")
					: theme.fg("muted", "○ Available");

				return {
					value: skill.name,
					label: `${theme.bold(skill.name)}  ${theme.fg("dim", `[${skill.category}]`)}  ${statusBadge}`,
					description: skill.description,
				};
			});

			this.#setContent(() => {
				this.#selectList = new SelectList(
					selectItems,
					Math.min(selectItems.length, 7),
					getSelectListTheme(),
				);
				this.#selectList.onSelect = item => {
					const found = this.#state.items.find(s => s.name === item.value);
					if (found) this.#openSkillPanel(found);
				};
				this.#selectList.onCancel = () => this.onClose?.();
				this.addChild(this.#selectList);
			});
		}

		this.onRequestRender?.();
	}

	#openSkillPanel(skill: SkillItem): void {
		this.#setContent(() => {
			this.#activePanel = new SkillActionPanel(
				skill,
				this.#stateManager,
				async statusMsg => {
					this.#state.statusMessage = statusMsg;
					this.#state.isLoading = true;
					this.#setContent(() => {
						this.addChild(new Text(theme.fg("accent", "  Updating skills catalog..."), 0, 0));
					});
					this.onRequestRender?.();

					this.#state.items = await this.#stateManager.loadSkills();
					this.#state.isLoading = false;
					this.#refreshTabCounts();
					this.#refreshContent();
				},
				() => this.onRequestRender?.(),
			);
			this.addChild(this.#activePanel);
		});
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		if (this.#activePanel) {
			this.#activePanel.handleInput(data);
			return;
		}

		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "left") ||
			matchesKey(data, "right")
		) {
			this.#tabBar.handleInput(data);
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = this.#state.searchQuery.slice(0, -1);
				this.#refreshContent();
				return;
			}
		}

		if (data === "\x1b" || data === "\x1b\x1b") {
			if (this.#state.searchQuery) {
				this.#state.searchQuery = "";
				this.#refreshContent();
				return;
			}
			this.onClose?.();
			return;
		}

		const printable = extractPrintableText(data);
		if (printable !== undefined && printable.length > 0) {
			this.#state.searchQuery += printable;
			this.#refreshContent();
			return;
		}

		if (this.#selectList) {
			this.#selectList.handleInput(data);
		}
	}
}
