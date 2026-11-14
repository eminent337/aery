/**
 * Left Pane: Swarm Hierarchy and active subagent tree.
 */

import type { SwarmBoardPanel } from "@aryee337/aery-swarm";
import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../theme/theme.js";
import type { StudioAgentNode } from "./types.js";

export class StudioHierarchyPanel extends Container {
	#selectList: SelectList | null = null;
	#agents: StudioAgentNode[] = [];
	#onSelectAgent: (id: string) => void;
	#swarmBoardPanel?: SwarmBoardPanel;
	#viewMode: "tree" | "board" = "tree";

	constructor(agents: StudioAgentNode[], onSelectAgent: (id: string) => void, swarmBoardPanel?: SwarmBoardPanel) {
		super();
		this.#agents = agents;
		this.#onSelectAgent = onSelectAgent;
		this.#swarmBoardPanel = swarmBoardPanel;
		this.#renderTree();
	}

	updateAgents(agents: StudioAgentNode[]): void {
		this.#agents = agents;
		this.#renderTree();
	}

	setSwarmBoard(panel?: SwarmBoardPanel): void {
		this.#swarmBoardPanel = panel;
	}

	getSwarmBoard(): SwarmBoardPanel | undefined {
		return this.#swarmBoardPanel;
	}

	setViewMode(mode: "tree" | "board"): void {
		this.#viewMode = mode;
	}

	getViewMode(): "tree" | "board" {
		return this.#viewMode;
	}

	toggleViewMode(): void {
		this.#viewMode = this.#viewMode === "tree" ? "board" : "tree";
	}

	#renderTree(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "  ✦ Swarm Hierarchy & Active Agents")), 0, 0));
		this.addChild(new Spacer(1));

		if (this.#agents.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No agents registered in this session."), 0, 0));
			return;
		}

		const items: SelectItem[] = this.#agents.map(agent => {
			const statusIcon =
				agent.status === "running"
					? theme.fg("success", "🟢 Running")
					: agent.status === "idle"
						? theme.fg("warning", "💬 Idle")
						: agent.status === "completed"
							? theme.fg("accent", "✅ Done")
							: theme.fg("muted", "○ Parked");

			const prefix = agent.id === "Main" ? "● " : "  └─ ";
			return {
				value: agent.id,
				label: `${prefix}${theme.bold(agent.displayName)}  ${statusIcon}`,
				description: agent.currentTool
					? `Tool: ${agent.currentTool} ${agent.currentToolArgs || ""}`
					: `Kind: ${agent.kind}`,
			};
		});

		this.#selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#onSelectAgent(item.value);
		};

		this.addChild(this.#selectList);
	}

	override render(width: number): string[] {
		if (this.#viewMode === "board") {
			if (this.#swarmBoardPanel) {
				const header = [
					theme.bold(theme.fg("accent", "  ✦ Swarm Board [3-Pane View] (Press 'b' to toggle tree)")),
					"",
				];
				const boardLines = this.#swarmBoardPanel.render(width, 24);
				return [...header, ...boardLines];
			}
			return [
				theme.bold(theme.fg("accent", "  ✦ Swarm Board [3-Pane View] (Press 'b' to toggle tree)")),
				"",
				theme.fg("muted", "  No swarm board attached to this session."),
			];
		}
		return super.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "b")) {
			this.toggleViewMode();
			return;
		}

		if (this.#viewMode === "board" && this.#swarmBoardPanel) {
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				this.#swarmBoardPanel.selectPrev();
				return;
			}
			if (matchesKey(data, "down") || matchesKey(data, "j")) {
				this.#swarmBoardPanel.selectNext();
				return;
			}
			return;
		}

		this.#selectList?.handleInput(data);
	}
}
