import {
	type Component,
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	TabBar,
	Text,
} from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { getTabBarTheme } from "../../shared";
import { DynamicBorder } from "../dynamic-border";
import { ConnectPlatformPanel } from "./connect-platform-panel";
import { ConnectStateManager } from "./state";
import type { ConnectHubState, PlatformConfig } from "./types";

/**
 * Advanced Connect Hub TUI Component.
 * Enables live configuration, connection, status monitoring, and disconnection
 * of Slack and Telegram chat connectors directly from the interactive TUI.
 */
export class ConnectHub extends Container {
	#stateManager: ConnectStateManager;
	#state: ConnectHubState;

	#tabBar!: TabBar;
	#footer: Component[] = [];
	#selectList: SelectList | null = null;
	#activePanel: ConnectPlatformPanel | null = null;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(
		private readonly cwd: string,
		sessionFile?: string,
	) {
		super();
		this.#stateManager = new ConnectStateManager(cwd, sessionFile);
		this.#state = {
			activeTab: "platforms",
			platforms: [],
			selectedPlatform: null,
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
			new Text(theme.bold(theme.fg("accent", "  ⚡ Chat Platform Connectors Hub")), 0, 0),
		);
		this.addChild(
			new Text(
				theme.fg("dim", "  Bridge your live Aery agent to Slack channels or Telegram direct chats"),
				0,
				0,
			),
		);

		// Tab bar at top
		const tabs = this.#buildTabs();
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const active = this.#tabBar.getActiveTab();
			this.#state.activeTab = active.id as "platforms" | "active";
			this.#refreshContent();
			this.onRequestRender?.();
		};

		this.addChild(new Spacer(1));
		this.addChild(this.#tabBar);
		this.addChild(new Spacer(1));

		// Footer: hint + bottom border
		this.#footer = [
			new Spacer(1),
			new Text(
				theme.fg("dim", "  ↑/↓: navigate · Enter: configure/connect · Tab: switch tab · Esc: close"),
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
		const activeCount = this.#state.platforms.filter(p => p.status === "connected").length;
		return [
			{ id: "platforms", label: `✦ All Platforms (${this.#state.platforms.length})` },
			{ id: "active", label: `● Active Connections (${activeCount})` },
		];
	}

	#refreshTabCounts(): void {
		const tabs = this.#buildTabs();
		const tabIds = ["platforms", "active"];
		this.#tabBar.setTabs(tabs, this.#state.activeTab);
		this.#tabBar.setActiveIndex(tabIds.indexOf(this.#state.activeTab));
	}

	async #load(): Promise<void> {
		this.#setContent(() => {
			this.addChild(new Text(theme.fg("accent", "  Loading platform connectors..."), 0, 0));
		});
		this.onRequestRender?.();

		this.#state.platforms = await this.#stateManager.loadPlatforms();
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
		const displayedPlatforms =
			this.#state.activeTab === "active"
				? this.#state.platforms.filter(p => p.status === "connected")
				: this.#state.platforms;

		if (displayedPlatforms.length === 0) {
			this.#setContent(() => {
				this.addChild(
					new Text(
						theme.fg(
							"muted",
							this.#state.activeTab === "active"
								? "  No active platform connections. Select a platform to connect."
								: "  No platforms available.",
						),
						0,
						0,
					),
				);
			});
		} else {
			const selectItems: SelectItem[] = displayedPlatforms.map(platform => {
				const statusIcon =
					platform.status === "connected"
						? theme.fg("success", "● Connected")
						: platform.status === "error"
							? theme.fg("error", "✕ Error")
							: theme.fg("muted", "○ Disconnected");

				return {
					value: platform.id,
					label: `${platform.icon} ${theme.bold(platform.name)}  ${theme.fg("dim", `[${platform.mode}]`)}  ${statusIcon}`,
					description: platform.description,
				};
			});

			this.#setContent(() => {
				this.#selectList = new SelectList(
					selectItems,
					Math.min(selectItems.length, 6),
					getSelectListTheme(),
				);
				this.#selectList.onSelect = item => {
					const found = this.#state.platforms.find(p => p.id === item.value);
					if (found) this.#openPlatformPanel(found);
				};
				this.#selectList.onCancel = () => this.onClose?.();
				this.addChild(this.#selectList);
			});
		}

		this.onRequestRender?.();
	}

	#openPlatformPanel(platform: PlatformConfig): void {
		this.#setContent(() => {
			this.#activePanel = new ConnectPlatformPanel(
				platform,
				this.#stateManager,
				async statusMsg => {
					this.#state.statusMessage = statusMsg;
					this.#state.isLoading = true;
					this.#setContent(() => {
						this.addChild(new Text(theme.fg("accent", "  Updating connector state..."), 0, 0));
					});
					this.onRequestRender?.();

					this.#state.platforms = await this.#stateManager.loadPlatforms();
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
			this.onRequestRender?.();
			return;
		}

		if (data === "\x1b" || data === "\x1b\x1b") {
			this.onClose?.();
			return;
		}

		if (this.#selectList) {
			this.#selectList.handleInput(data);
			this.onRequestRender?.();
		}
	}
}
