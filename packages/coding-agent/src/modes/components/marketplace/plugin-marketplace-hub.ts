/**
 * Settings-style Plugins & Marketplace Hub TUI Component.
 *
 * Architecture mirrors SettingsSelectorComponent:
 *  - Top: DynamicBorder + permanent SettingsSearchHeader (renders nothing when idle)
 *  - Middle: swappable content (plugin list or action panel)
 *  - Footer: Spacer + TabBar + DynamicBorder
 *
 * Input routing:
 *  - Tab / Shift+Tab / Left / Right → this.#tabBar.handleInput()
 *  - Printable chars → start/extend search
 *  - Backspace → shorten search query
 *  - Esc → clear search or close
 *  - Arrows / Enter → forwarded to the active SelectList
 */
import {
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
	type Component,
} from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { getTabBarTheme } from "../../shared";
import { DynamicBorder } from "../dynamic-border";
import { PluginActionPanel } from "./plugin-action-panel";
import { HubStateManager } from "./state";
import type { HubExtensionItem, HubState, HubTabId } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Inline search banner (always mounted, renders 0 lines when idle)
// ─────────────────────────────────────────────────────────────────────────────
class HubSearchHeader implements Component {
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
		const count = theme.fg(this.#matchCount > 0 ? "dim" : "warning", countText);
		const gap = Math.max(1, width - visibleWidth(left) - rightWidth);
		const line = truncateToWidth(`${left}${"".padEnd(gap)}${count} `, width);
		return [line, ""];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Hub component
// ─────────────────────────────────────────────────────────────────────────────
export class PluginMarketplaceHub extends Container {
	#stateManager: HubStateManager;
	#state: HubState;

	// Permanent children (always in tree)
	#searchHeader = new HubSearchHeader();
	#tabBar!: TabBar;
	#footer: Component[] = [];

	// Swappable middle content
	#selectList: SelectList | null = null;
	#activeSubmenu: PluginActionPanel | null = null;
	#emptyText: Text | null = null;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(
		private readonly cwd: string,
		initialTab: HubTabId = "marketplace",
	) {
		super();
		this.#stateManager = new HubStateManager(cwd);
		this.#state = {
			activeTab: initialTab,
			searchQuery: "",
			items: [],
			filteredItems: [],
			selectedIndex: 0,
			selectedItem: null,
			isLoading: true,
		};
		this.#buildShell();
		void this.#load();
	}

	/** Build the permanent chrome (borders, search header, tab bar footer). */
	#buildShell(): void {
		this.clear();

		// Top chrome
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(
				theme.bold(theme.fg("accent", `  ${theme.icon.package ?? "✦"} Plugins & Extensions Marketplace`)),
				0,
				0,
			),
		);
		this.addChild(this.#searchHeader);

		// Build tab bar
		const tabs = this.#buildTabs();
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const active = this.#tabBar.getActiveTab();
			this.#state.activeTab = active.id as HubTabId;
			this.#state.searchQuery = "";
			this.#searchHeader.clear();
			this.#refreshContent();
			this.onRequestRender?.();
		};

		// Footer (spacer + tab bar + bottom border)
		this.#footer = [
			new Spacer(1),
			new Text(
				theme.fg("dim", "  ↑/↓ navigate · Enter: details · Tab: switch tab · Type to search · Esc: close"),
				0,
				0,
			),
			this.#tabBar,
			new DynamicBorder(),
		];
		for (const child of this.#footer) {
			this.addChild(child);
		}

		// Set initial active tab index
		const tabIds: HubTabId[] = ["marketplace", "installed", "updates"];
		this.#tabBar.setActiveIndex(tabIds.indexOf(this.#state.activeTab));
	}

	#buildTabs() {
		const installedCount = this.#state.items.filter(i => i.installed).length;
		const updatesCount = this.#state.items.filter(
			i => i.installed && i.latestVersion && i.version !== i.latestVersion,
		).length;
		return [
			{ id: "marketplace", label: "✦ Marketplace" },
			{ id: "installed", label: `● Installed (${installedCount})` },
			{ id: "updates", label: `↑ Updates (${updatesCount})` },
		];
	}

	/** Refresh the tab bar labels (counts) without switching tabs. */
	#refreshTabCounts(): void {
		const tabs = this.#buildTabs();
		const tabIds: HubTabId[] = ["marketplace", "installed", "updates"];
		this.#tabBar.setTabs(tabs, this.#state.activeTab);
		this.#tabBar.setActiveIndex(tabIds.indexOf(this.#state.activeTab));
	}

	async #load(): Promise<void> {
		this.#setContent(() => {
			this.addChild(new Text(theme.fg("accent", "  Loading Extensions & Marketplace..."), 0, 0));
		});
		this.onRequestRender?.();

		const items = await this.#stateManager.loadHubState();
		this.#state.items = items;
		this.#state.isLoading = false;
		this.#refreshTabCounts();
		this.#refreshContent();
	}

	/**
	 * Replace only the middle content section (between the search header and
	 * the footer). Footer stays attached below the new content.
	 */
	#setContent(build: () => void): void {
		// Remove current middle content
		if (this.#selectList) {
			this.removeChild(this.#selectList);
			this.#selectList = null;
		}
		if (this.#emptyText) {
			this.removeChild(this.#emptyText);
			this.#emptyText = null;
		}
		if (this.#activeSubmenu) {
			this.removeChild(this.#activeSubmenu);
			this.#activeSubmenu = null;
		}

		// Detach footer, build new content, re-attach footer below
		for (const child of this.#footer) {
			this.removeChild(child);
		}
		build();
		for (const child of this.#footer) {
			this.addChild(child);
		}
	}

	#refreshContent(): void {
		this.#state.filteredItems = this.#stateManager.filterItems(
			this.#state.items,
			this.#state.activeTab,
			this.#state.searchQuery,
		);

		// Update search banner
		if (this.#state.searchQuery) {
			this.#searchHeader.update(this.#state.searchQuery, this.#state.filteredItems.length);
		} else {
			this.#searchHeader.clear();
		}

		if (this.#state.filteredItems.length === 0) {
			this.#setContent(() => {
				this.#emptyText = new Text(
					theme.fg("muted", "  No plugins found matching criteria"),
					0,
					0,
				);
				this.addChild(this.#emptyText);
			});
		} else {
			const selectItems: SelectItem[] = this.#state.filteredItems.map(item => {
				const badge = item.tier === "core" ? "⚙" : item.tier === "verified" ? "✦" : "◆";
				const status = item.installed
					? item.enabled
						? theme.fg("success", "●")
						: theme.fg("muted", "○")
					: theme.fg("dim", "＋");
				const action = item.installed ? `[v${item.version}]` : `[Install]`;
				return {
					value: item.id,
					label: `${status} ${badge} ${item.name}  ${theme.fg("dim", action)}`,
					description: item.description,
				};
			});

			this.#setContent(() => {
				this.#selectList = new SelectList(selectItems, Math.min(selectItems.length, 8), getSelectListTheme());
				this.#selectList.onSelect = (item: SelectItem) => {
					const selected = this.#state.filteredItems.find(i => i.id === item.value);
					if (selected) this.#openSubmenu(selected);
				};
				this.#selectList.onCancel = () => {
					if (this.#state.searchQuery) {
						this.#state.searchQuery = "";
						this.#searchHeader.clear();
						this.#refreshContent();
						this.onRequestRender?.();
					} else {
						this.onClose?.();
					}
				};
				this.addChild(this.#selectList);
			});
		}

		this.onRequestRender?.();
	}

	#openSubmenu(item: HubExtensionItem): void {
		this.#setContent(() => {
			this.#activeSubmenu = new PluginActionPanel(item, this.#stateManager, async statusMsg => {
				this.#state.statusMessage = statusMsg;
				this.#state.isLoading = true;
				this.#setContent(() => {
					this.addChild(new Text(theme.fg("accent", "  Updating plugin state..."), 0, 0));
				});
				this.onRequestRender?.();

				this.#state.items = await this.#stateManager.loadHubState();
				this.#state.isLoading = false;
				this.#refreshTabCounts();
				this.#refreshContent();
			});
			this.addChild(this.#activeSubmenu);
		});
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		// Submenu owns all input
		if (this.#activeSubmenu) {
			this.#activeSubmenu.handleInput(data);
			return;
		}

		// Tab / Shift+Tab / Left / Right → delegate to TabBar (same as Settings)
		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "left") ||
			matchesKey(data, "right")
		) {
			this.#tabBar.handleInput(data);
			return;
		}

		// Escape: clear search or close
		if (data === "\x1b" || data === "\x1b\x1b") {
			if (this.#state.searchQuery) {
				this.#state.searchQuery = "";
				this.#searchHeader.clear();
				this.#refreshContent();
				this.onRequestRender?.();
			} else {
				this.onClose?.();
			}
			return;
		}

		// Backspace: shorten search
		if (data === "\x7f" || data === "\b") {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = this.#state.searchQuery.slice(0, -1);
				if (this.#state.searchQuery.length === 0) {
					this.#searchHeader.clear();
				}
				this.#refreshContent();
				this.onRequestRender?.();
				return;
			}
		}

		// Printable character → extend search
		const printable = extractPrintableText(data);
		if (printable !== undefined && printable.trim().length > 0) {
			this.#state.searchQuery += printable;
			this.#refreshContent();
			this.onRequestRender?.();
			return;
		}

		// Everything else (arrows, Enter) → forward to SelectList
		if (this.#selectList) {
			this.#selectList.handleInput(data);
		}
	}
}
