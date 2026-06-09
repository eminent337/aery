/**
 * Aery Damage Control Extension (Phase 1.7)
 * Blocks dangerous commands and protects sensitive paths.
 * Config: ~/.aery/agent/damage-control.yaml
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";

interface DamageControlConfig {
	block?: string[];
	protect?: string[];
	read_only?: string[];
}

function loadConfig(): DamageControlConfig {
	const path = join(homedir(), ".aery", "agent", "damage-control.yaml");
	if (!existsSync(path)) return {};
	try {
		const text = readFileSync(path, "utf-8");
		const result: DamageControlConfig = {};
		let section: keyof DamageControlConfig | null = null;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			if (trimmed === "block:") {
				section = "block";
				result.block = [];
				continue;
			}
			if (trimmed === "protect:") {
				section = "protect";
				result.protect = [];
				continue;
			}
			if (trimmed === "read_only:") {
				section = "read_only";
				result.read_only = [];
				continue;
			}
			if (section && trimmed.startsWith("- ")) {
				(result[section] as string[]).push(trimmed.slice(2).replace(/^["']|["']$/g, ""));
			}
		}
		return result;
	} catch {
		return {};
	}
}

// Built-in always-blocked patterns (cannot be overridden)
const ALWAYS_BLOCK = [
	/rm\s+-rf\s+\/(?:\s|$)/,
	/mkfs\./,
	/dd\s+.*of=\/dev\/(sd|hd|nvme)/,
	/:(){:|:&};:/, // fork bomb
];

export default function (aery: ExtensionAPI) {
	const config = loadConfig();

	aery.on("tool_call", async (event, _ctx) => {
		const toolName = event.toolName;
		const input = event.input as any;

		// Check bash commands
		if (toolName === "bash") {
			const cmd = input?.command ?? "";

			// Always-blocked patterns
			for (const pattern of ALWAYS_BLOCK) {
				if (pattern.test(cmd)) {
					return {
						block: true,
						reason: `Blocked by damage control: dangerous command pattern detected.\nCommand: ${cmd}`,
					};
				}
			}

			// User-configured block patterns
			for (const pattern of config.block ?? []) {
				if (cmd.includes(pattern)) {
					return { block: true, reason: `Blocked by damage control rule: "${pattern}"\nCommand: ${cmd}` };
				}
			}
		}

		// Check file write/edit operations
		if (toolName === "write" || toolName === "edit") {
			const filePath = input?.path ?? "";
			const expandedHome = filePath.replace(/^~/, homedir());

			// Protected paths — block writes
			for (const pattern of config.protect ?? []) {
				const expanded = pattern.replace(/^~/, homedir());
				if (expandedHome.startsWith(expanded) || expandedHome.includes(pattern.replace(/^~\//, ""))) {
					return {
						block: true,
						reason: `Blocked by damage control: "${filePath}" is a protected path.\nAdd to damage-control.yaml to modify this rule.`,
					};
				}
				// Glob pattern (*.pem, *.key, etc.)
				if (pattern.startsWith("*.")) {
					const ext = pattern.slice(1);
					if (expandedHome.endsWith(ext)) {
						return {
							block: true,
							reason: `Blocked by damage control: "${filePath}" matches protected pattern "${pattern}".`,
						};
					}
				}
			}

			// Read-only paths — block writes but allow reads
			for (const pattern of config.read_only ?? []) {
				const expanded = pattern.replace(/^~/, homedir());
				if (expandedHome.startsWith(expanded) || expandedHome === expanded) {
					return {
						block: true,
						reason: `Blocked by damage control: "${filePath}" is read-only.\nRemove from read_only in damage-control.yaml to allow writes.`,
					};
				}
			}
		}
	});
}
