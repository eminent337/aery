/**
 * Aery Damage Control Extension (Phase 1.7)
 * Blocks dangerous commands and protects sensitive paths.
 * Config: ~/.aery/agent/damage-control.yaml
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";
import { SecurityAuditLogger } from "./security-audit";

export interface DamageControlConfig {
	block?: string[];
	protect?: string[];
	read_only?: string[];
	allow_git_writes?: boolean;
	audit_log_path?: string;
	logger?: SecurityAuditLogger;
}

export function loadConfig(configPath?: string): DamageControlConfig {
	const path = configPath ?? join(homedir(), ".aery", "agent", "damage-control.yaml");
	if (!existsSync(path)) return {};
	try {
		const text = readFileSync(path, "utf-8");
		const result: DamageControlConfig = {};
		let section: "block" | "protect" | "read_only" | null = null;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			if (trimmed.startsWith("allow_git_writes:")) {
				const val = trimmed.slice("allow_git_writes:".length).trim().toLowerCase();
				result.allow_git_writes = val === "true";
				section = null;
				continue;
			}
			if (trimmed.startsWith("audit_log_path:")) {
				result.audit_log_path = trimmed
					.slice("audit_log_path:".length)
					.trim()
					.replace(/^["']|["']$/g, "");
				section = null;
				continue;
			}
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

// Dangerous git mutations blocked unless allow_git_writes is enabled
const GIT_MUTATION_PATTERNS = [
	/rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|-rf|-fr)\s+.*\.git(?:\/|\s|$)/,
	/>\s*.*\.git\//,
	/git\s+clean\s+-[a-zA-Z]*f/,
	/git\s+checkout\s+(-f\b|--force\b|-[a-zA-Z]*f)/,
];

export function isGitPath(filePath: string): boolean {
	if (!filePath) return false;
	const expanded = filePath.replace(/^~/, homedir());
	const normalized = expanded.replace(/\\/g, "/").trim();
	if (
		normalized === ".git" ||
		normalized.startsWith(".git/") ||
		normalized.startsWith("./.git/") ||
		normalized.includes("/.git/") ||
		normalized.endsWith("/.git")
	) {
		return true;
	}
	try {
		const resolved = resolve(expanded).replace(/\\/g, "/");
		if (resolved.endsWith("/.git") || resolved.includes("/.git/")) {
			return true;
		}
	} catch {
		// Ignore path resolution errors
	}
	return false;
}

export default function damageControl(aery: ExtensionAPI, configOverride?: DamageControlConfig) {
	const config: DamageControlConfig = {
		allow_git_writes: false,
		...loadConfig(),
		...configOverride,
	};
	const logger = config.logger ?? new SecurityAuditLogger(config.audit_log_path);

	aery.on("tool_call", async (event, _ctx) => {
		const toolName = event.toolName;
		const input = event.input as any;

		// Check bash commands
		if (toolName === "bash") {
			const cmd = input?.command ?? "";

			// Always-blocked patterns
			for (const pattern of ALWAYS_BLOCK) {
				if (pattern.test(cmd)) {
					const reason = `Blocked by damage control: dangerous command pattern detected.\nCommand: ${cmd}`;
					logger.logDecision({
						timestamp: new Date().toISOString(),
						toolName,
						action: "execute",
						target: cmd,
						decision: "block",
						rule: "always_blocked",
						reason,
					});
					return {
						block: true,
						reason,
					};
				}
			}

			// Block dangerous git mutations unless allow_git_writes is true
			if (!config.allow_git_writes) {
				for (const pattern of GIT_MUTATION_PATTERNS) {
					if (pattern.test(cmd)) {
						const reason = `Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).\nCommand: ${cmd}`;
						logger.logDecision({
							timestamp: new Date().toISOString(),
							toolName,
							action: "execute",
							target: cmd,
							decision: "block",
							rule: "blockGitWrites",
							reason,
						});
						return {
							block: true,
							reason,
						};
					}
				}
			}

			// User-configured block patterns
			for (const pattern of config.block ?? []) {
				if (cmd.includes(pattern)) {
					const reason = `Blocked by damage control rule: "${pattern}"\nCommand: ${cmd}`;
					logger.logDecision({
						timestamp: new Date().toISOString(),
						toolName,
						action: "execute",
						target: cmd,
						decision: "block",
						rule: "user_rule",
						reason,
					});
					return { block: true, reason };
				}
			}

			// Allowed bash command
			logger.logDecision({
				timestamp: new Date().toISOString(),
				toolName,
				action: "execute",
				target: cmd,
				decision: "allow",
			});
			return;
		}

		// Check file write/edit operations
		if (toolName === "write" || toolName === "edit") {
			const filePath = input?.path ?? "";
			const action = toolName;

			// Block direct writes to .git metadata unless allow_git_writes is true
			if (!config.allow_git_writes && isGitPath(filePath)) {
				const reason = "Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).";
				logger.logDecision({
					timestamp: new Date().toISOString(),
					toolName,
					action,
					target: filePath,
					decision: "block",
					rule: "blockGitWrites",
					reason,
				});
				return {
					block: true,
					reason,
				};
			}

			const expandedHome = filePath.replace(/^~/, homedir());

			// Protected paths - block writes
			for (const pattern of config.protect ?? []) {
				const expanded = pattern.replace(/^~/, homedir());
				if (expandedHome.startsWith(expanded) || expandedHome.includes(pattern.replace(/^~\//, ""))) {
					const reason = `Blocked by damage control: "${filePath}" is a protected path.\nAdd to damage-control.yaml to modify this rule.`;
					logger.logDecision({
						timestamp: new Date().toISOString(),
						toolName,
						action,
						target: filePath,
						decision: "block",
						rule: "protected_path",
						reason,
					});
					return {
						block: true,
						reason,
					};
				}
				// Glob pattern (*.pem, *.key, etc.)
				if (pattern.startsWith("*.")) {
					const ext = pattern.slice(1);
					if (expandedHome.endsWith(ext)) {
						const reason = `Blocked by damage control: "${filePath}" matches protected pattern "${pattern}".`;
						logger.logDecision({
							timestamp: new Date().toISOString(),
							toolName,
							action,
							target: filePath,
							decision: "block",
							rule: "protected_path",
							reason,
						});
						return {
							block: true,
							reason,
						};
					}
				}
			}

			// Read-only paths - block writes but allow reads
			for (const pattern of config.read_only ?? []) {
				const expanded = pattern.replace(/^~/, homedir());
				if (expandedHome.startsWith(expanded) || expandedHome === expanded) {
					const reason = `Blocked by damage control: "${filePath}" is read-only.\nRemove from read_only in damage-control.yaml to allow writes.`;
					logger.logDecision({
						timestamp: new Date().toISOString(),
						toolName,
						action,
						target: filePath,
						decision: "block",
						rule: "read_only",
						reason,
					});
					return {
						block: true,
						reason,
					};
				}
			}

			// Allowed write/edit operation
			logger.logDecision({
				timestamp: new Date().toISOString(),
				toolName,
				action,
				target: filePath,
				decision: "allow",
			});
			return;
		}

		// Allow other tools
		logger.logDecision({
			timestamp: new Date().toISOString(),
			toolName,
			action: toolName,
			target: input?.path ?? input?.command ?? "",
			decision: "allow",
		});
	});

	return { logger, config };
}
