// ─── Agent Tool Interface ─────────────────────────────────────────────────────

import type { ToolResult } from "./types";

/** JSON Schema-compatible type for a single tool parameter */
export interface AeryToolParameter {
	type: "string" | "number" | "boolean" | "array" | "object";
	/** Human-readable description shown to the agent */
	description: string;
	/** Whether the parameter must be supplied. Defaults to false */
	required?: boolean;
	/** Default value when the parameter is omitted */
	default?: unknown;
	/** Restrict the parameter to a specific set of allowed values */
	enum?: unknown[];
}

/**
 * A tool definition that can be registered with the Aery runtime.
 * The agent may invoke registered tools during its reasoning loop.
 */
export interface AeryTool {
	/** Unique tool name (snake_case recommended) */
	name: string;
	/** Clear description of what the tool does — the agent reads this */
	description: string;
	/** Map of parameter name → parameter definition */
	parameters: Record<string, AeryToolParameter>;
	/** Called by the runtime when the agent decides to invoke this tool */
	execute: (params: Record<string, unknown>) => Promise<ToolResult>;
	/** If true, the user must explicitly approve each invocation */
	requiresApproval?: boolean;
	/** If true, the tool makes no persistent changes (safe to run freely) */
	isReadOnly?: boolean;
	/** Optional taxonomy tags for filtering / grouping tools */
	tags?: string[];
}

/**
 * Identity helper — returns the tool unchanged.
 * Useful for getting full TypeScript inference on inline tool definitions.
 *
 * @example
 * const myTool = defineTool({
 *   name: "echo",
 *   description: "Echoes text back",
 *   parameters: { text: { type: "string", description: "Text to echo", required: true } },
 *   execute: async ({ text }) => ({ content: String(text) }),
 * });
 */
export function defineTool(tool: AeryTool): AeryTool {
	return tool;
}
