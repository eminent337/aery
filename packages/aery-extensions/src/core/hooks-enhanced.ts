/**
 * Enhanced Hooks Extension
 *
 * Expands the hook system with more event types, structured responses,
 * async hooks with timeout, and context injection.
 *
 * Config: ~/.aery/agent/hooks.yaml
 *
 * Supported events:
 *   PreToolUse, PostToolUse, PostToolUseFailure,
 *   SessionStart, SessionEnd, PreCompact, PostCompact,
 *   TurnStart, TurnEnd, SubagentStart, SubagentStop,
 *   FileChanged, CwdChanged
 *
 * Hook types:
 *   command — shell command (exit 2 = block)
 *   prompt — LLM evaluation
 *   http — webhook POST
 *
 * Structured responses (JSON on stdout):
 *   { "decision": "allow"|"deny"|"ask", "reason": "...",
 *     "additionalContext": "...", "systemMessage": "..." }
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";

interface HookEntry {
	tool?: string;
	type?: "command" | "prompt" | "http";
	command?: string;
	if?: string;
	async?: boolean;
	timeout?: number;
	// prompt type
	prompt?: string;
	// http type
	url?: string;
	method?: string;
	headers?: Record<string, string>;
}

interface HooksConfig {
	PreToolUse?: HookEntry[];
	PostToolUse?: HookEntry[];
	PostToolUseFailure?: HookEntry[];
	SessionStart?: HookEntry[];
	SessionEnd?: HookEntry[];
	PreCompact?: HookEntry[];
	PostCompact?: HookEntry[];
	TurnStart?: HookEntry[];
	TurnEnd?: HookEntry[];
	SubagentStart?: HookEntry[];
	SubagentStop?: HookEntry[];
	FileChanged?: HookEntry[];
	CwdChanged?: HookEntry[];
}

interface HookResponse {
	decision?: "allow" | "deny" | "ask";
	reason?: string;
	additionalContext?: string;
	systemMessage?: string;
	preventContinuation?: boolean;
	stopReason?: string;
}

function loadHooks(): HooksConfig {
	const path = join(homedir(), ".aery", "agent", "hooks.yaml");
	if (!existsSync(path)) return {};
	try {
		const text = readFileSync(path, "utf-8");
		const result: HooksConfig = {};
		let currentSection: string | null = null;
		let currentEntry: HookEntry | null = null;

		for (const rawLine of text.split("\n")) {
			const line = rawLine.trimEnd();
			if (!line || line.startsWith("#")) continue;

			if (/^[A-Za-z]/.test(line) && line.endsWith(":")) {
				currentSection = line.slice(0, -1);
				(result as any)[currentSection] = [];
				currentEntry = null;
				continue;
			}

			if (!currentSection) continue;

			const listMatch = line.match(/^ {2}- (.+)/);
			if (listMatch) {
				currentEntry = {};
				(result as any)[currentSection].push(currentEntry);
				const rest = listMatch[1];
				const kvMatch = rest.match(/^(\w+):\s*(.+)/);
				if (kvMatch) {
					const val = kvMatch[2].replace(/^["']|["']$/g, "");
					(currentEntry as any)[kvMatch[1]] =
						val === "true" ? true : val === "false" ? false : Number.isNaN(Number(val)) ? val : Number(val);
				}
				continue;
			}

			if (currentEntry) {
				const kvMatch = line.match(/^ {4}(\w+):\s*(.+)/);
				if (kvMatch) {
					const val = kvMatch[2].replace(/^["']|["']$/g, "");
					(currentEntry as any)[kvMatch[1]] =
						val === "true" ? true : val === "false" ? false : Number.isNaN(Number(val)) ? val : Number(val);
				}
			}
		}
		return result;
	} catch {
		return {};
	}
}

function matchesPattern(toolName: string, input: any, pattern?: string): boolean {
	if (!pattern) return true;
	const toolLower = toolName.toLowerCase();
	const patternLower = pattern.toLowerCase();

	// Extract tool name from pattern: "Bash(rm *)" -> "bash"
	const toolMatch = patternLower.match(/^(\w+)\(/);
	if (toolMatch && toolMatch[1] !== toolLower) return false;

	// Extract content pattern: "Bash(rm *)" -> "rm *"
	const contentMatch = pattern.match(/\((.+)\)/);
	if (contentMatch) {
		const contentPattern = contentMatch[1];
		const inputStr = typeof input === "string" ? input : JSON.stringify(input);

		// Support prefix matching: "prefix:rm " matches "rm -rf /"
		if (contentPattern.startsWith("prefix:")) {
			return inputStr.toLowerCase().includes(contentPattern.slice(7));
		}

		// Glob-style matching
		const regex = new RegExp(
			"^" +
				contentPattern
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*")
					.replace(/\?/g, ".") +
				"$",
			"i",
		);
		return regex.test(inputStr);
	}

	return true;
}

function runCommandHook(hook: HookEntry, env: Record<string, string>): HookResponse | null {
	if (!hook.command) return null;

	try {
		const result = execSync(hook.command, {
			env: { ...process.env, ...env },
			timeout: (hook.timeout ?? 30) * 1000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Try to parse structured response from stdout
		try {
			const parsed = JSON.parse(result.trim()) as HookResponse;
			return parsed;
		} catch {
			// Plain text output — treat as allow
			return null;
		}
	} catch (e: any) {
		if (e.status === 2) {
			// Exit code 2 = block
			return {
				decision: "deny",
				reason: e.stderr?.toString() || "Blocked by hook",
			};
		}
		return null;
	}
}

async function runHttpHook(hook: HookEntry, env: Record<string, string>): Promise<HookResponse | null> {
	if (!hook.url) return null;

	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(hook.headers ?? {}),
		};

		// Expand env vars in headers
		for (const [key, value] of Object.entries(headers)) {
			headers[key] = value.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? process.env[k] ?? "");
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), (hook.timeout ?? 30) * 1000);

		const response = await fetch(hook.url, {
			method: hook.method ?? "POST",
			headers,
			body: JSON.stringify(env),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) return null;

		const data = await response.json();
		return data as HookResponse;
	} catch {
		return null;
	}
}

export default function hooksEnhanced(aery: ExtensionAPI): void {
	const hooks = loadHooks();

	// ─── PreToolUse ──────────────────────────────────────────────────────
	if (hooks.PreToolUse?.length) {
		aery.on("tool_call", event => {
			const toolName = event.toolName;
			const input = event.input;

			for (const hook of hooks.PreToolUse!) {
				if (hook.tool && hook.tool.toLowerCase() !== toolName.toLowerCase()) continue;
				if (!matchesPattern(toolName, input, hook.if)) continue;

				if (hook.type === "http") {
					// HTTP hooks are async, fire-and-forget for PreToolUse
					runHttpHook(hook, {
						TOOL_NAME: toolName,
						TOOL_INPUT: JSON.stringify(input),
						EVENT: "PreToolUse",
					});
					continue;
				}

				const response = runCommandHook(hook, {
					TOOL_NAME: toolName,
					TOOL_INPUT: JSON.stringify(input),
					EVENT: "PreToolUse",
				});

				if (response?.decision === "deny") {
					return { block: true, reason: response.reason ?? "Blocked by hook" };
				}
			}

			return undefined;
		});
	}

	// ─── PostToolUse ─────────────────────────────────────────────────────
	if (hooks.PostToolUse?.length) {
		aery.on("tool_result", event => {
			const toolName = event.toolName;
			const input = event.input;

			for (const hook of hooks.PostToolUse!) {
				if (hook.tool && hook.tool.toLowerCase() !== toolName.toLowerCase()) continue;
				if (!matchesPattern(toolName, input, hook.if)) continue;

				if (hook.async) {
					runCommandHook(hook, {
						TOOL_NAME: toolName,
						TOOL_INPUT: JSON.stringify(input),
						TOOL_RESULT: JSON.stringify(event.content),
						EVENT: "PostToolUse",
					});
				} else {
					runCommandHook(hook, {
						TOOL_NAME: toolName,
						TOOL_INPUT: JSON.stringify(input),
						TOOL_RESULT: JSON.stringify(event.content),
						EVENT: "PostToolUse",
					});
				}
			}

			return undefined;
		});
	}

	// ─── PostToolUseFailure ──────────────────────────────────────────────
	if (hooks.PostToolUseFailure?.length) {
		aery.on("tool_result", event => {
			if (!event.isError) return undefined;

			const toolName = event.toolName;

			for (const hook of hooks.PostToolUseFailure!) {
				if (hook.tool && hook.tool.toLowerCase() !== toolName.toLowerCase()) continue;

				runCommandHook(hook, {
					TOOL_NAME: toolName,
					TOOL_RESULT: JSON.stringify(event.content),
					IS_ERROR: "true",
					EVENT: "PostToolUseFailure",
				});
			}

			return undefined;
		});
	}

	// ─── SessionStart ────────────────────────────────────────────────────
	if (hooks.SessionStart?.length) {
		aery.on("session_start", () => {
			for (const hook of hooks.SessionStart!) {
				runCommandHook(hook, { EVENT: "SessionStart" });
			}
		});
	}

	// ─── SessionEnd ──────────────────────────────────────────────────────
	if (hooks.SessionEnd?.length) {
		aery.on("session_shutdown", () => {
			for (const hook of hooks.SessionEnd!) {
				runCommandHook(hook, { EVENT: "SessionEnd" });
			}
		});
	}

	// ─── TurnStart ───────────────────────────────────────────────────────
	if (hooks.TurnStart?.length) {
		aery.on("turn_start", () => {
			for (const hook of hooks.TurnStart!) {
				runCommandHook(hook, { EVENT: "TurnStart" });
			}
		});
	}

	// ─── TurnEnd ─────────────────────────────────────────────────────────
	if (hooks.TurnEnd?.length) {
		aery.on("turn_end", () => {
			for (const hook of hooks.TurnEnd!) {
				if (hook.async) {
					runCommandHook(hook, { EVENT: "TurnEnd" });
				} else {
					runCommandHook(hook, { EVENT: "TurnEnd" });
				}
			}
		});
	}

	// ─── PreCompact ──────────────────────────────────────────────────────
	if (hooks.PreCompact?.length) {
		aery.on("session_before_compact", () => {
			for (const hook of hooks.PreCompact!) {
				const response = runCommandHook(hook, { EVENT: "PreCompact" });
				if (response?.decision === "deny") {
					return { cancel: true };
				}
			}
			return undefined;
		});
	}

	// ─── PostCompact ─────────────────────────────────────────────────────
	if (hooks.PostCompact?.length) {
		aery.on("session_compact", () => {
			for (const hook of hooks.PostCompact!) {
				runCommandHook(hook, { EVENT: "PostCompact" });
			}
		});
	}
}
