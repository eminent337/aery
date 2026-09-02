/**
 * Main Fullscreen Container for Aery Studio (/studio).
 * Provides interactive switching between Panes, live updates, and keyboard navigation.
 */

import { Container, matchesKey, Spacer, TabBar, Text } from "@aryee337/aery-tui";
import { getTabBarTheme } from "../../shared.js";
import { theme } from "../../theme/theme.js";
import { DynamicBorder } from "../dynamic-border.js";
import { VideoPlayer, type VideoPlayerTheme } from "../video-player.js";
import { MediaStateManager } from "./media-state.js";
import { StudioStateManager } from "./state.js";
import { StudioChatPanel } from "./studio-chat-panel.js";
import { StudioHierarchyPanel } from "./studio-hierarchy-panel.js";
import { StudioInspectorPanel } from "./studio-inspector-panel.js";
import { StudioMediaPanel } from "./studio-media-panel.js";
import type { StudioTab } from "./types.js";

export class AeryStudioOverlay extends Container {
	#stateManager: StudioStateManager;
	#tabBar: TabBar;
	#hierarchyPanel: StudioHierarchyPanel;
	#chatPanel: StudioChatPanel;
	#mediaUnsubscribe?: () => void;
	#mediaPanel: StudioMediaPanel;
	#videoPlayer?: VideoPlayer;
	#playerKeyListener?: (data: string) => { consume?: boolean } | undefined;
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
				{ id: "generate", label: "🎨 Generate" },
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

		const mediaManager = MediaStateManager.instance();
		this.#mediaPanel = new StudioMediaPanel(mediaManager.getSnapshot(), {
			onGenerate: (kind, prompt) => {
				mediaManager.enqueue({ kind, subject: prompt });
			},
			onMoveSelection: delta => {
				mediaManager.moveSelection(delta);
			},
			onOpenInPlayer: (videoPath: string) => {
				void this.#openInPlayer(videoPath);
			},
		});
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

		this.#mediaUnsubscribe = MediaStateManager.instance().subscribe(() => {
			this.#mediaPanel.updateSnapshot(MediaStateManager.instance().getSnapshot());
		});
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#mediaUnsubscribe?.();
		this.#closeVideoPlayer();
	}

	/** Open a completed video in the inline frame-cycling player. */
	async #openInPlayer(videoPath: string): Promise<void> {
		// One player at a time: reopen replaces the previous one.
		this.#closeVideoPlayer();

		const playerTheme: VideoPlayerTheme = {
			fallbackColor: (s: string) => theme.fg("toolOutput", s),
			accentColor: (s: string) => theme.fg("accent", s),
			dimColor: (s: string) => theme.fg("toolOutput", s),
			successColor: (s: string) => theme.fg("success", s),
		};
		const player = new VideoPlayer(videoPath, playerTheme);
		this.#videoPlayer = player;

		// The player draws itself via its own render loop; route its global
		// alt-chords through the overlay's input path so chat stays usable.
		const setup = await player.start({
			addInputListener: listener => {
				this.#playerKeyListener = listener;
				return () => {
					if (this.#playerKeyListener === listener) this.#playerKeyListener = undefined;
				};
			},
			requestRender: () => this.onRequestRender?.(),
		});
		if (!setup.ready) {
			// Could not start (no ffmpeg etc.) — surface the fallback line.
			this.#closeVideoPlayer();
		}
		this.onRequestRender?.();
	}

	#closeVideoPlayer(): void {
		this.#videoPlayer?.close();
		this.#videoPlayer = undefined;
		this.#playerKeyListener = undefined;
	}

	#buildLayout(): void {
		const state = this.#stateManager.getState();
		this.#tabBar.setTabs([
			{ id: "swarm", label: "✦ Swarm Hierarchy" },
			{ id: "chat", label: `💬 Inter-Agent IRC (${state.chatMessages.length})` },
			{ id: "inspector", label: "🔍 Diff & Consensus Inspector" },
			{ id: "generate", label: "🎨 Generate" },
		]);
		this.#hierarchyPanel.updateAgents(state.agents);
		this.#chatPanel.updateMessages(state.chatMessages);
		const selectedAgent = state.agents.find(a => a.id === state.activeAgentId);
		this.#inspectorPanel.update(selectedAgent, state.diffs, state.consensusAgreedCount, state.consensusTotalCount);

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
		if (state.activeTab === "swarm") {
			this.#contentContainer.addChild(this.#hierarchyPanel);
		} else if (state.activeTab === "chat") {
			this.#contentContainer.addChild(this.#chatPanel);
		} else if (state.activeTab === "generate") {
			this.#contentContainer.addChild(this.#mediaPanel);
			if (this.#videoPlayer) {
				this.#contentContainer.addChild(this.#videoPlayer);
			}
		} else {
			this.#contentContainer.addChild(this.#inspectorPanel);
		}

		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));
		const footer = theme.fg(
			"dim",
			"  [Tab / ← / →] Switch View · [↑ / ↓] Select Agent · Generate tab: [enter] render · [←/→] gallery · [Esc / F2] Exit",
		);
		this.addChild(new Text(footer, 0, 0));
		this.addChild(new DynamicBorder());

		this.onRequestRender?.();
	}

	#syncState(): void {
		this.#buildLayout();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "q")) {
			this.onClose?.();
			return;
		}

		// Video player alt-chords (play/pause, seek, restart, close) take
		// priority over everything but Escape.
		const playerListener = this.#playerKeyListener;
		if (playerListener) {
			const handled = playerListener(data);
			if (handled?.consume) {
				this.onRequestRender?.();
				return;
			}
		}

		const activeTabId = this.#tabBar.getActiveTab()?.id;
		const isGenerate = activeTabId === "generate";

		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			(!isGenerate && (matchesKey(data, "left") || matchesKey(data, "right")))
		) {
			this.#tabBar.handleInput(data);
			this.onRequestRender?.();
			return;
		}

		const state = this.#stateManager.getState();

		if (state.activeTab === "generate") {
			// Tab still switches views; ←/→ drives gallery selection inside the
			// media panel; everything else (typing, enter) goes to the prompt.
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				this.#tabBar.handleInput(data);
				this.onRequestRender?.();
				return;
			}
			this.#mediaPanel.handleMediaKey(data);
			this.#mediaPanel.handleTextInput(data);
			this.onRequestRender?.();
			return;
		}

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
