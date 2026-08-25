/**
 * Right Pane: Diffs, Artifacts, and Consensus Tracker.
 */

import { Container, Text, Spacer } from "@aryee337/aery-tui";
import { theme } from "../../theme/theme.js";
import type { StudioAgentNode, StudioInspectorDiff } from "./types.js";

export class StudioInspectorPanel extends Container {
	#selectedAgent?: StudioAgentNode;
	#diffs: StudioInspectorDiff[] = [];
	#consensusAgreed = 0;
	#consensusTotal = 0;

	constructor(selectedAgent?: StudioAgentNode, diffs: StudioInspectorDiff[] = [], agreed = 0, total = 0) {
		super();
		this.#selectedAgent = selectedAgent;
		this.#diffs = diffs;
		this.#consensusAgreed = agreed;
		this.#consensusTotal = total;
		this.#renderInspector();
	}

	update(selectedAgent?: StudioAgentNode, diffs: StudioInspectorDiff[] = [], agreed = 0, total = 0): void {
		this.#selectedAgent = selectedAgent;
		this.#diffs = diffs;
		this.#consensusAgreed = agreed;
		this.#consensusTotal = total;
		this.#renderInspector();
	}

	#renderInspector(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "  🔍 Inspector & Consensus Tracker")), 0, 0));
		this.addChild(new Spacer(1));

		// Consensus status
		const consensusBar = `  ● Team Consensus: ${theme.bold(theme.fg("success", `${this.#consensusAgreed}/${this.#consensusTotal} Agents Synchronized`))}`;
		this.addChild(new Text(consensusBar, 0, 0));
		this.addChild(new Spacer(1));

		// Selected agent details
		if (this.#selectedAgent) {
			this.addChild(new Text(theme.bold(`  [Agent: ${this.#selectedAgent.displayName}]`), 0, 0));
			this.addChild(new Text(`    ID: ${this.#selectedAgent.id} · Kind: ${this.#selectedAgent.kind}`, 0, 0));
			this.addChild(new Text(`    Status: ${this.#selectedAgent.status}`, 0, 0));
			if (this.#selectedAgent.currentTool) {
				this.addChild(new Text(`    Current Action: ${this.#selectedAgent.currentTool}`, 0, 0));
			}
			if (this.#selectedAgent.assignment) {
				this.addChild(new Text(`    Assignment: ${this.#selectedAgent.assignment.slice(0, 120)}...`, 0, 0));
			}
			this.addChild(new Spacer(1));
		}

		// Diffs section
		this.addChild(new Text(theme.bold("  [Recent Diff Patches & Artifacts]"), 0, 0));
		if (this.#diffs.length === 0) {
			this.addChild(new Text(theme.fg("muted", "    No recent file diffs recorded in this session."), 0, 0));
		} else {
			for (const diff of this.#diffs.slice(0, 5)) {
				this.addChild(new Text(`    📄 ${theme.bold(diff.filePath)} ${theme.fg("dim", `(by ${diff.authorAgentId})`)}`, 0, 0));
			}
		}
	}

	handleInput(_data: string): void {}
}
