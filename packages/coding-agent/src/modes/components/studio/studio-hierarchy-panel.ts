/**
 * Left Pane: Swarm Hierarchy and active subagent tree.
 */

import { Container, SelectList, type SelectItem, Text, Spacer } from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../theme/theme.js";
import type { StudioAgentNode } from "./types.js";

export class StudioHierarchyPanel extends Container {
	#selectList: SelectList | null = null;
	#agents: StudioAgentNode[] = [];
	#onSelectAgent: (id: string) => void;

	constructor(agents: StudioAgentNode[], onSelectAgent: (id: string) => void) {
		super();
		this.#agents = agents;
		this.#onSelectAgent = onSelectAgent;
		this.#renderTree();
	}

	updateAgents(agents: StudioAgentNode[]): void {
		this.#agents = agents;
		this.#renderTree();
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
				description: agent.currentTool ? `Tool: ${agent.currentTool} ${agent.currentToolArgs || ""}` : `Kind: ${agent.kind}`,
			};
		});

		this.#selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#onSelectAgent(item.value);
		};

		this.addChild(this.#selectList);
	}

	handleInput(data: string): void {
		this.#selectList?.handleInput(data);
	}
}
