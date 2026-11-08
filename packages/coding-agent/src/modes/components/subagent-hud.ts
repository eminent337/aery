import { Container, Text } from "@aryee337/aery-tui";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface ActiveSubagentInfo {
	id: string;
	agent: string;
	status: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
}

export class SubagentActivityHudComponent extends Container {
	#subagents: ActiveSubagentInfo[] = [];

	setSubagents(subagents: ActiveSubagentInfo[]): void {
		this.#subagents = [...subagents];
		this.#rebuild();
	}

	clearSubagents(): void {
		this.#subagents = [];
		this.#rebuild();
	}

	getSubagents(): ActiveSubagentInfo[] {
		return [...this.#subagents];
	}

	get count(): number {
		return this.#subagents.length;
	}

	#formatToolArgs(rawArgs: string | undefined): string {
		if (!rawArgs) return "";
		try {
			const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
			if (typeof parsed === "object" && parsed !== null) {
				const entries = Object.entries(parsed);
				if (entries.length > 0) {
					const [key, val] = entries[0];
					const strVal = String(val);
					const truncatedVal = strVal.length > 30 ? `${strVal.slice(0, 27)}…` : strVal;
					return `${key}: ${truncatedVal}`;
				}
			}
		} catch {
			// Not JSON, return truncated raw string
		}
		return rawArgs.length > 30 ? `${rawArgs.slice(0, 27)}…` : rawArgs;
	}

	#cleanRole(rawName: string): string {
		if (!rawName || rawName.toLowerCase() === "claudeagent" || rawName.toLowerCase() === "task") {
			return "Subagent";
		}
		return rawName.replace(/\s*\[(?:self|research|image-generator)\]$/i, "").trim();
	}

	#rebuild(): void {
		this.clear();
		if (this.#subagents.length === 0) return;

		const countStr = theme.fg("dim", `(${this.#subagents.length} active)`);
		const title = ` ${theme.fg("dim", "Subagent Activity")} ${countStr}`;
		this.addChild(new Text(title, 0, 0));

		for (const sub of this.#subagents) {
			const dot = theme.fg("accent", "⠋");
			const idBadge = theme.fg("dim", `[${sub.id}]`);
			const cleanName = this.#cleanRole(sub.agent);
			const role = theme.bold(cleanName);

			let detail = "";
			if (sub.currentTool) {
				const args = this.#formatToolArgs(sub.currentToolArgs);
				detail = args ? `${sub.currentTool}(${args})` : sub.currentTool;
			} else if (sub.lastIntent) {
				detail = sub.lastIntent.length > 40 ? `${sub.lastIntent.slice(0, 37)}…` : sub.lastIntent;
			} else {
				detail = sub.status || "active";
			}

			const line = `  ${dot} ${idBadge} ${role} · ${theme.fg("muted", detail)}`;
			this.addChild(new Text(line, 0, 0));
		}
	}
}
