/**
 * Settings-style Plugins & Marketplace Hub TUI Component.
 */
import { Container, extractPrintableText, type SelectItem, SelectList, Spacer, TabBar, Text } from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { getTabBarTheme } from "../../shared";
import { DynamicBorder } from "../dynamic-border";
import { PluginActionPanel } from "./plugin-action-panel";
import { HubStateManager } from "./state";
import type { HubExtensionItem, HubState, HubTabId } from "./types";

export class PluginMarketplaceHub extends Container {
	#stateManager: HubStateManager;
	#state: HubState;
	#tabBar!: TabBar;
	#selectList!: SelectList;
	#activeSubmenu: PluginActionPanel | null = null;

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
		void this.#init();
	}

	async #init(): Promise<void> {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "  Loading Extensions & Marketplace...")), 0, 0));
		this.addChild(new DynamicBorder());

		const items = await this.#stateManager.loadHubState();
		this.#state.items = items;
		this.#state.isLoading = false;
		this.#refreshView();
	}

	#refreshView(): void {
		if (this.#activeSubmenu) return;

		this.clear();
		this.#state.filteredItems = this.#stateManager.filterItems(
			this.#state.items,
			this.#state.activeTab,
			this.#state.searchQuery,
		);

		// Top Border
		this.addChild(new DynamicBorder());

		// Header / Title
		this.addChild(
			new Text(
				theme.bold(theme.fg("accent", `  ${theme.icon.package ?? "✦"} Plugins & Extensions Marketplace`)),
				0,
				0,
			),
		);

		// Search Header if active
		if (this.#state.searchQuery) {
			const count = `${this.#state.filteredItems.length} match${this.#state.filteredItems.length === 1 ? "" : "es"}`;
			this.addChild(
				new Text(
					`  ${theme.fg("accent", "🔍")} ${theme.bold(this.#state.searchQuery)}${theme.fg("accent", "▌")}  ${theme.fg("dim", `(${count})`)}`,
					0,
					0,
				),
			);
		}

		// Tab Bar
		const tabs = [
			{ id: "marketplace", label: "✦ Marketplace" },
			{ id: "installed", label: `● Installed (${this.#state.items.filter(i => i.installed).length})` },
			{
				id: "updates",
				label: `↑ Updates (${this.#state.items.filter(i => i.installed && i.latestVersion && i.version !== i.latestVersion).length})`,
			},
		];
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const active = this.#tabBar.getActiveTab();
			this.#state.activeTab = active.id as unknown as HubTabId;
			this.#refreshView();
			this.onRequestRender?.();
		};
		this.addChild(this.#tabBar);
		this.addChild(new Spacer(1));

		// Items Select List
		if (this.#state.filteredItems.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No plugins found matching criteria"), 0, 0));
			this.addChild(new Spacer(1));
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

			this.#selectList = new SelectList(selectItems, Math.min(selectItems.length, 8), getSelectListTheme());
			this.#selectList.onSelect = item => {
				const selected = this.#state.filteredItems.find(i => i.id === item.value);
				if (selected) {
					this.#openSubmenu(selected);
				}
			};
			this.#selectList.onCancel = () => {
				if (this.#state.searchQuery) {
					this.#state.searchQuery = "";
					this.#refreshView();
					this.onRequestRender?.();
				} else {
					this.onClose?.();
				}
			};
			this.addChild(this.#selectList);
		}

		// Status / Help
		this.addChild(new Spacer(1));
		const statusText = this.#state.statusMessage
			? theme.fg("success", `  ${this.#state.statusMessage}`)
			: theme.fg("dim", "  ↑/↓: navigate · Enter: action panel · Tab: switch tab · Type to search · Esc: close");
		this.addChild(new Text(statusText, 0, 0));
		this.addChild(new DynamicBorder());

		this.onRequestRender?.();
	}

	#openSubmenu(item: HubExtensionItem): void {
		this.#activeSubmenu = new PluginActionPanel(item, this.#stateManager, async statusMsg => {
			this.#activeSubmenu = null;
			this.#state.statusMessage = statusMsg;
			this.#state.isLoading = true;
			this.clear();
			this.addChild(new Text(theme.fg("accent", "  Updating plugin state..."), 0, 0));
			this.onRequestRender?.();

			this.#state.items = await this.#stateManager.loadHubState();
			this.#state.isLoading = false;
			this.#refreshView();
		});

		this.clear();
		this.addChild(this.#activeSubmenu);
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		if (this.#activeSubmenu) {
			this.#activeSubmenu.handleInput(data);
			return;
		}

		// Tab switching
		if (data === "\t") {
			const tabs: HubTabId[] = ["marketplace", "installed", "updates"];
			const idx = tabs.indexOf(this.#state.activeTab);
			const nextIdx = (idx + 1) % tabs.length;
			this.#state.activeTab = tabs[nextIdx];
			this.#tabBar.setActiveIndex(nextIdx);
			this.#refreshView();
			return;
		}
		if (data === "\x1b[Z") {
			// Shift+Tab
			const tabs: HubTabId[] = ["marketplace", "installed", "updates"];
			const idx = tabs.indexOf(this.#state.activeTab);
			const prevIdx = (idx - 1 + tabs.length) % tabs.length;
			this.#state.activeTab = tabs[prevIdx];
			this.#tabBar.setActiveIndex(prevIdx);
			this.#refreshView();
			return;
		}

		// Escape
		if (data === "\x1b" || data === "\x1b\x1b") {
			if (this.#state.searchQuery) {
				this.#state.searchQuery = "";
				this.#refreshView();
			} else {
				this.onClose?.();
			}
			return;
		}

		// Backspace for search
		if (data === "\x7f" || data === "\b") {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = this.#state.searchQuery.slice(0, -1);
				this.#refreshView();
				return;
			}
		}

		// Printable character for instant search
		const printable = extractPrintableText(data);
		if (printable && printable.length === 1 && printable >= " ") {
			this.#state.searchQuery += printable;
			this.#refreshView();
			return;
		}

		// Navigation in select list
		if (this.#selectList) {
			this.#selectList.handleInput(data);
		}
	}
}
