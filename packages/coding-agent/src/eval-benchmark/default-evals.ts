/**
 * Default benchmark evaluation rules for Aery agent behavior.
 *
 * These rules capture common tool-usage patterns and help assess whether
 * the agent follows recommended practices. Users can extend or replace
 * these via extension configuration.
 */

import type { BenchmarkEval } from "./types.js";

/** Helper: create a matcher that checks tool name and a predicate on input. */
function toolMatcher(
	toolName: string,
	predicate: (input: Record<string, unknown>) => boolean,
): (event: { toolName: string; input: Record<string, unknown> }) => boolean {
	return event => event.toolName === toolName && predicate(event.input);
}

/** Helper: create a matcher for bash commands matching a prefix. */
function bashCommand(prefix: string): (event: { toolName: string; input: Record<string, unknown> }) => boolean {
	return toolMatcher("bash", input => {
		const cmd = input.command;
		return typeof cmd === "string" && cmd.trim().startsWith(prefix);
	});
}

/** Helper: create a matcher for any invocation of a tool. */
function anyTool(toolName: string): (event: { toolName: string; input: Record<string, unknown> }) => boolean {
	return event => event.toolName === toolName;
}

/**
 * Default set of evaluation rules.
 *
 * Observed (good) rules track recommended usage patterns.
 * Violated (bad) rules track patterns that should be avoided.
 */
export function defaultEvals(): BenchmarkEval[] {
	return [
		// ── Observed (recommended usage) ────────────────────────────────────────
		{
			name: "use_edit_instead_of_write",
			description: "Agent prefers edit tool over write for existing files",
			matcher: toolMatcher("edit", () => true),
			expected: "observed",
		},
		{
			name: "use_read_before_edit",
			description: "Agent reads a file before editing it",
			matcher: toolMatcher("read", () => true),
			expected: "observed",
		},
		{
			name: "use_search_for_exploration",
			description: "Agent uses search tool for code exploration",
			matcher: toolMatcher("search", () => true),
			expected: "observed",
		},
		{
			name: "use_git_for_vcs",
			description: "Agent uses git for version control operations",
			matcher: bashCommand("git "),
			expected: "observed",
		},
		{
			name: "use_test_runner",
			description: "Agent runs tests after making changes",
			matcher: toolMatcher("bash", input => {
				const cmd = input.command;
				return typeof cmd === "string" && /^(bun test|cargo test|npm test|go test)\b/.test(cmd.trim());
			}),
			expected: "observed",
		},
		// ── Violated (anti-patterns) ────────────────────────────────────────────
		{
			name: "raw_write_to_existing",
			description: "Agent should avoid write tool when edit suffices",
			matcher: anyTool("write"),
			expected: "violated",
		},
		{
			name: "destructive_operation",
			description: "Agent performs potentially destructive operations",
			matcher: toolMatcher("bash", input => {
				const cmd = input.command;
				return typeof cmd === "string" && /\b(rm\s+-rf|chmod\s+777|dd\s+if=)\b/.test(cmd);
			}),
			expected: "violated",
		},
	];
}
