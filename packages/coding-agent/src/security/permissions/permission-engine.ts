/**
 * Fine-Grained Permission & Workspace Trust Engine.
 *
 * Implements Google Antigravity-style declarative access control lists (ACLs):
 * - command(...) allow/deny rules
 * - file_read / file_write paths with allowNonWorkspaceAccess boundary enforcement
 * - mcp(...) tool access rules
 * - trustedWorkspaces isolation
 */

import * as path from "node:path";
import type { ParsedPermissionRule, PermissionAction, PermissionEvaluationResult, WorkspaceTrustConfig } from "./types";

export class PermissionEngine {
	private static instance?: PermissionEngine;
	private rules: ParsedPermissionRule[] = [];
	private trustedWorkspaces: string[] = [];
	private allowNonWorkspaceAccess = true;

	constructor(config?: WorkspaceTrustConfig) {
		if (config) {
			this.configure(config);
		}
	}

	public static getInstance(): PermissionEngine {
		if (!PermissionEngine.instance) {
			PermissionEngine.instance = new PermissionEngine();
		}
		return PermissionEngine.instance;
	}

	public configure(config: WorkspaceTrustConfig): void {
		this.rules = [];
		this.trustedWorkspaces = (config.trustedWorkspaces || []).map(p => path.resolve(p));
		this.allowNonWorkspaceAccess = config.allowNonWorkspaceAccess ?? true;

		if (config.permissions?.deny) {
			for (const r of config.permissions.deny) {
				const parsed = this.parseRule(r, "deny");
				if (parsed) this.rules.push(parsed);
			}
		}

		if (config.permissions?.allow) {
			for (const r of config.permissions.allow) {
				const parsed = this.parseRule(r, "allow");
				if (parsed) this.rules.push(parsed);
			}
		}
	}

	public clear(): void {
		this.rules = [];
		this.trustedWorkspaces = [];
		this.allowNonWorkspaceAccess = true;
	}

	/**
	 * Checks if a command execution is allowed.
	 */
	public checkCommand(rawCommand: string): PermissionEvaluationResult {
		const cmd = rawCommand.trim();

		// 1. Deny rules have top priority
		for (const rule of this.rules) {
			if (rule.action === "command" && rule.effect === "deny") {
				if (this.matchCommand(rule.pattern, cmd)) {
					return {
						allowed: false,
						reason: `Command blocked by explicit deny rule: ${rule.raw}`,
						matchedRule: rule,
					};
				}
			}
		}

		// 2. Allow rules (if any exist for commands)
		const allowRules = this.rules.filter(r => r.action === "command" && r.effect === "allow");
		if (allowRules.length === 0) {
			// No explicit allow restrictions, allowed by default
			return { allowed: true };
		}

		for (const rule of allowRules) {
			if (this.matchCommand(rule.pattern, cmd)) {
				return {
					allowed: true,
					matchedRule: rule,
				};
			}
		}

		return {
			allowed: false,
			reason: `Command does not match any allowed command grants (e.g. command(...))`,
		};
	}

	/**
	 * Checks if reading or writing a file is allowed under workspace boundary policy.
	 */
	public checkFileAccess(
		targetPath: string,
		mode: "read" | "write",
		activeWorkspace?: string,
	): PermissionEvaluationResult {
		const resolvedTarget = path.resolve(targetPath);
		const action: PermissionAction = mode === "write" ? "file_write" : "file_read";

		// 1. Workspace boundary check if allowNonWorkspaceAccess is false
		if (!this.allowNonWorkspaceAccess) {
			const inActiveWorkspace = activeWorkspace && resolvedTarget.startsWith(path.resolve(activeWorkspace));
			const inTrustedWorkspace = this.trustedWorkspaces.some(w => resolvedTarget.startsWith(w));

			if (!inActiveWorkspace && !inTrustedWorkspace) {
				return {
					allowed: false,
					reason: `Access to '${targetPath}' denied: non-workspace path access is disabled by security policy.`,
				};
			}
		}

		// 2. Deny rules
		for (const rule of this.rules) {
			if (rule.action === action && rule.effect === "deny") {
				if (this.matchPath(rule.pattern, resolvedTarget)) {
					return {
						allowed: false,
						reason: `File ${mode} blocked by explicit deny rule: ${rule.raw}`,
						matchedRule: rule,
					};
				}
			}
		}

		// 3. Allow rules
		const allowRules = this.rules.filter(r => r.action === action && r.effect === "allow");
		if (allowRules.length === 0) {
			return { allowed: true };
		}

		for (const rule of allowRules) {
			if (this.matchPath(rule.pattern, resolvedTarget)) {
				return { allowed: true, matchedRule: rule };
			}
		}

		return {
			allowed: false,
			reason: `File ${mode} on '${targetPath}' is not permitted by allow rules.`,
		};
	}

	/**
	 * Checks if an MCP tool call is allowed.
	 */
	public checkMcp(serverName: string, toolName: string): PermissionEvaluationResult {
		const target = `${serverName}/${toolName}`;

		// 1. Deny rules
		for (const rule of this.rules) {
			if (rule.action === "mcp" && rule.effect === "deny") {
				if (this.matchMcp(rule.pattern, serverName, toolName)) {
					return {
						allowed: false,
						reason: `MCP tool blocked by explicit deny rule: ${rule.raw}`,
						matchedRule: rule,
					};
				}
			}
		}

		// 2. Allow rules
		const allowRules = this.rules.filter(r => r.action === "mcp" && r.effect === "allow");
		if (allowRules.length === 0) {
			return { allowed: true };
		}

		for (const rule of allowRules) {
			if (this.matchMcp(rule.pattern, serverName, toolName)) {
				return { allowed: true, matchedRule: rule };
			}
		}

		return {
			allowed: false,
			reason: `MCP tool '${target}' not granted in permission allowlist.`,
		};
	}

	private parseRule(raw: string, effect: "allow" | "deny"): ParsedPermissionRule | null {
		const trimmed = raw.trim();
		const match = trimmed.match(/^([a-zA-Z_]+)\((.*)\)$/);
		if (!match) return null;

		const action = match[1] as PermissionAction;
		let pattern = match[2].trim();

		// Strip surrounding single/double quotes if present
		if ((pattern.startsWith("'") && pattern.endsWith("'")) || (pattern.startsWith('"') && pattern.endsWith('"'))) {
			pattern = pattern.slice(1, -1).trim();
		}

		return {
			raw: trimmed,
			action,
			pattern,
			effect,
		};
	}

	private matchCommand(pattern: string, actualCommand: string): boolean {
		if (pattern === "*" || pattern === ".*") return true;

		// Exact command prefix match e.g. "git status" matches "git status -s"
		if (actualCommand === pattern || actualCommand.startsWith(`${pattern} `)) {
			return true;
		}

		// Wildcard match e.g. "git *" or "bun run *"
		if (pattern.includes("*")) {
			const regexStr = `^${pattern
				.split("*")
				.map(s => escapeRegex(s))
				.join(".*")}$`;
			const regex = new RegExp(regexStr);
			if (regex.test(actualCommand)) return true;
		}

		// Command base binary match e.g. "cat" matches "cat file.txt"
		const actualBinary = actualCommand.split(/\s+/)[0];
		if (pattern === actualBinary) return true;

		return false;
	}

	private matchPath(pattern: string, targetPath: string): boolean {
		if (pattern === "*" || pattern === "**") return true;

		if (pattern.includes("*")) {
			const regexStr = `^${pattern
				.split("**")
				.map(p => p.split("*").map(escapeRegex).join("[^/]*"))
				.join(".*")}$`;
			return new RegExp(regexStr).test(targetPath);
		}

		return targetPath.startsWith(path.resolve(pattern));
	}

	private matchMcp(pattern: string, server: string, tool: string): boolean {
		if (pattern === "*" || pattern === "*/*") return true;
		const full = `${server}/${tool}`;
		if (pattern === full) return true;
		if (pattern === `${server}/*`) return true;
		return false;
	}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
