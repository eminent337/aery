/**
 * Tool execution hooks — pre/post execute waterfall for Aery.
 *
 * Inspired by DeepSeek Harness's `tools/pre-execute → execute → post-execute → result`
 * pipeline. Hooks let any part of the system intercept tool execution for
 * logging, metrics, audit, or policy enforcement.
 *
 * Usage:
 *   registerPreExecute("bash", async (args, ctx) => {
 *     // Can deny by throwing ToolDenyError
 *     // Can modify args by returning new args
 *     return args;
 *   });
 *
 *   registerPostExecute("bash", async (result, ctx) => {
 *     // Can inspect or replace result
 *     return result;
 *   });
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";

/**
 * Context passed to hook handlers. Read-only view of the tool call.
 */
export interface ToolHookContext {
	/** Tool name being executed */
	readonly toolName: string;
	/** Tool call ID */
	readonly callId: string;
	/** Abort signal for cancellation */
	readonly signal: AbortSignal;
}

/**
 * Pre-execute hook. Runs before the tool body.
 *
 * @param args - The parsed tool arguments (validated against the tool schema).
 * @param ctx - Read-only context for the call.
 * @returns Modified args (or the same args if no modification).
 * @throws {ToolDenyError} To deny the tool call.
 */
export type PreExecuteHook = (args: unknown, ctx: ToolHookContext) => Promise<unknown> | unknown;

/**
 * Post-execute hook. Runs after the tool body settles.
 *
 * @param result - The tool's result.
 * @param ctx - Read-only context for the call.
 * @returns Modified result (or the same result if no modification).
 */
export type PostExecuteHook = (
	result: AgentToolResult,
	ctx: ToolHookContext,
) => Promise<AgentToolResult> | AgentToolResult;

/**
 * Error thrown by a pre-execute hook to deny the tool call.
 */
export class ToolDenyError extends Error {
	readonly code = "TOOL_DENIED" as const;
	constructor(
		message: string,
		readonly toolName: string,
	) {
		super(message);
		this.name = "ToolDenyError";
	}
}

// ── Hook registry ──

const preExecuteHooks = new Map<string, PreExecuteHook[]>();
const postExecuteHooks = new Map<string, PostExecuteHook[]>();

/**
 * Register a pre-execute hook for a specific tool.
 *
 * @param toolName - Tool name to hook, or "*" for all tools.
 * @param handler - Hook function.
 * @returns Disposer to unregister.
 */
export function registerPreExecute(toolName: string, handler: PreExecuteHook): () => void {
	const hooks = preExecuteHooks.get(toolName) ?? [];
	hooks.push(handler);
	preExecuteHooks.set(toolName, hooks);
	return () => {
		const current = preExecuteHooks.get(toolName) ?? [];
		const idx = current.indexOf(handler);
		if (idx >= 0) current.splice(idx, 1);
	};
}

/**
 * Register a post-execute hook for a specific tool.
 *
 * @param toolName - Tool name to hook, or "*" for all tools.
 * @param handler - Hook function.
 * @returns Disposer to unregister.
 */
export function registerPostExecute(toolName: string, handler: PostExecuteHook): () => void {
	const hooks = postExecuteHooks.get(toolName) ?? [];
	hooks.push(handler);
	postExecuteHooks.set(toolName, hooks);
	return () => {
		const current = postExecuteHooks.get(toolName) ?? [];
		const idx = current.indexOf(handler);
		if (idx >= 0) current.splice(idx, 1);
	};
}

/**
 * Get pre-execute hooks for a tool (including global "*" hooks).
 */
function getPreHooks(toolName: string): PreExecuteHook[] {
	const global = preExecuteHooks.get("*") ?? [];
	const specific = preExecuteHooks.get(toolName) ?? [];
	return [...global, ...specific];
}

/**
 * Get post-execute hooks for a tool (including global "*" hooks).
 */
function getPostHooks(toolName: string): PostExecuteHook[] {
	const global = postExecuteHooks.get("*") ?? [];
	const specific = postExecuteHooks.get(toolName) ?? [];
	return [...global, ...specific];
}

/**
 * Execute a tool through the waterfall pipeline.
 *
 * 1. Run pre-execute hooks (can deny or modify args)
 * 2. Execute tool body
 * 3. Run post-execute hooks (can inspect or replace result)
 *
 * @param tool - The tool to execute.
 * @param callId - The tool call ID.
 * @param args - The parsed arguments.
 * @param signal - Abort signal.
 * @returns The tool result after post-execute hooks.
 */
export async function executeWithHooks(
	tool: AgentTool,
	callId: string,
	args: unknown,
	signal: AbortSignal,
): Promise<AgentToolResult> {
	const ctx: ToolHookContext = {
		toolName: tool.name,
		callId,
		signal,
	};

	// Pre-execute phase
	let currentArgs = args;
	for (const hook of getPreHooks(tool.name)) {
		currentArgs = await hook(currentArgs, ctx);
	}

	// Execution phase
	const result = await tool.execute(callId, currentArgs, signal);

	// Post-execute phase
	let currentResult = result;
	for (const hook of getPostHooks(tool.name)) {
		currentResult = await hook(currentResult, ctx);
	}

	return currentResult;
}
