/**
 * Main Fullscreen Container for Aery Studio (/studio).
 * Provides interactive switching between Panes, live updates, and keyboard navigation.
 */

import { Container, matchesKey, Spacer, TabBar, Text } from "@aryee337/aery-tui";
import { getTabBarTheme } from "../../shared.js";
import { DynamicBorder } from "../dynamic-border.js";
import { theme } from "../../theme/theme.js";
import { StudioStateManager } from "./state.js";
import { StudioHierarchyPanel } from "./studio-hierarchy-panel.js";
import { StudioChatPanel } from "./studio-chat-panel.js";
import { StudioInspectorPanel } from "./studio-inspector-panel.js";
import type { StudioTab } from "./types.js";

export class AeryStudioOverlay extends Container {
	#stateManager: StudioStateManager;
	#tabBar: TabBar;
	#hierarchyPanel: StudioHierarchyPanel;
	#chatPanel: StudioChatPanel;
	#inspectorPanel: StudioInspectorPanel;
	#contentContainer: Container;
	#unsubscribe?: () => void;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(stateManager?: StudioStateManager) {
		super();
		this.#stateManager = stateManager ?? StudioStateManager.instance();

		const state = this.#stateManager.getState();
		this.#tabBar = new TabBar(
			"",
			[
				{ id: "swarm", label: "✦ Swarm Hierarchy" },
				{ id: "chat", label: `💬 Inter-Agent IRC (${state.chatMessages.length})` },
				{ id: "inspector", label: "🔍 Diff & Consensus Inspector" },
			],
			getTabBarTheme(),
			0,
		);

		this.#tabBar.onTabChange = () => {
			const activeTab = this.#tabBar.getActiveTab();
			if (activeTab) {
				this.#stateManager.setTab(activeTab.id as StudioTab);
			}
		};

		this.#hierarchyPanel = new StudioHierarchyPanel(state.agents, id => {
			this.#stateManager.selectAgent(id);
		});

		this.#chatPanel = new StudioChatPanel(state.chatMessages);

		const selectedAgent = state.agents.find(a => a.id === state.activeAgentId);
		this.#inspectorPanel = new StudioInspectorPanel(
			selectedAgent,
			state.diffs,
			state.consensusAgreedCount,
			state.consensusTotalCount,
		);

		this.#contentContainer = new Container();

		this.#buildLayout();

		this.#unsubscribe = this.#stateManager.subscribe(() => {
			this.#syncState();
		});
	}

	dispose(): void {
		this.#unsubscribe?.();
	}

	#buildLayout(): void {
		this.clear();
		this.addChild(new DynamicBorder());

		// Header
		const headerText = `  ${theme.bold(theme.fg("accent", "✦ Aery Studio"))}  ${theme.fg("dim", "— Multi-Agent Visual War-Room & Swarm Studio")}`;
		this.addChild(new Text(headerText, 0, 0));
		this.addChild(new Spacer(1));

		// Tab Bar
		this.addChild(this.#tabBar);
		this.addChild(new Spacer(1));

		// Active Content
		this.#contentContainer.clear();
		const state = this.#stateManager.getState();
		if (state.activeTab === "swarm") {
			this.#contentContainer.addChild(this.#hierarchyPanel);
		} else if (state.activeTab === "chat") {
			this.#contentContainer.addChild(this.#chatPanel);
		} else {
			this.#contentContainer.addChild(this.#inspectorPanel);
		}

		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));

		// Footer Hints
		const footer = theme.fg("dim", "  [Tab / ← / →] Switch View · [↑ / ↓] Select Agent · [Esc / F2] Exit Studio");
		this.addChild(new Text(footer, 0, 0));
		this.addChild(new DynamicBorder());

		this.onRequestRender?.();
	}

	#syncState(): void {
		const state = this.#stateManager.getState();
		this.#tabBar.setTabs([
			{ id: "swarm", label: "✦ Swarm Hierarchy" },
			{ id: "chat", label: `💬 Inter-Agent IRC (${state.chatMessages.length})` },
			{ id: "inspector", label: "🔍 Diff & Consensus Inspector" },
		]);

		this.#hierarchyPanel.updateAgents(state.agents);
		this.#chatPanel.updateMessages(state.chatMessages);

		const selectedAgent = state.agents.find(a => a.id === state.activeAgentId);
		this.#inspectorPanel.update(
			selectedAgent,
			state.diffs,
			state.consensusAgreedCount,
			state.consensusTotalCount,
		);

		this.#buildLayout();
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "q")) {
			this.onClose?.();
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

		const state = this.#stateManager.getState();
		if (state.activeTab === "swarm") {
			this.#hierarchyPanel.handleInput(data);
		} else if (state.activeTab === "chat") {
			this.#chatPanel.handleInput(data);
		} else {
			this.#inspectorPanel.handleInput(data);
		}
		this.onRequestRender?.();
	}
}
