import chalk from "chalk";
import type { Component } from "../tui.js";
import { sliceByColumn, visibleWidth } from "../utils.js";

export type NodeState = "pending" | "running" | "success" | "error";

export interface TreeNode {
	id: string;
	label: string;
	state: NodeState;
	children?: TreeNode[];
	error?: string;
}

export class ThoughtTree implements Component {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#nodes: TreeNode[] = [];
	#spinnerFrame = 0;

	constructor(nodes: TreeNode[], spinnerFrame?: number) {
		this.#nodes = nodes;
		this.#spinnerFrame = spinnerFrame ?? 0;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		this.#renderNodes(this.#nodes, "", true, lines, width);
		return lines;
	}

	#renderNodes(nodes: TreeNode[], prefix: string, isRoot: boolean, lines: string[], maxWidth: number) {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const isLast = i === nodes.length - 1;

			// Choose prefix (branch characters)
			let nodePrefix = "";
			if (!isRoot) {
				nodePrefix = prefix + (isLast ? "└─ " : "├─ ");
			}

			// Choose status icon
			let icon = "";
			switch (node.state) {
				case "pending":
					icon = chalk.dim("○");
					break;
				case "running": {
					const frame = this.#frames[this.#spinnerFrame % this.#frames.length];
					icon = chalk.cyan(frame);
					break;
				}
				case "success":
					icon = chalk.green("✓");
					break;
				case "error":
					icon = chalk.red("✗");
					break;
			}

			// Format line
			let label = node.label;
			if (node.state === "error" && node.error) {
				label += chalk.red(` (${node.error})`);
			} else if (node.state === "pending") {
				label = chalk.dim(label);
			} else if (node.state === "success") {
				label = chalk.dim(label);
			}

			let line = `${nodePrefix}${icon} ${label}`;
			if (visibleWidth(line) > maxWidth) {
				line = sliceByColumn(line, 0, maxWidth, true);
			}
			lines.push(line);

			// Render children
			if (node.children && node.children.length > 0) {
				const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
				this.#renderNodes(node.children, childPrefix, false, lines, maxWidth);
			}
		}
	}
}
