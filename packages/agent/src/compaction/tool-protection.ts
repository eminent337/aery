import type { ToolResultMessage } from "@aryee337/aery-ai";
import type { AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

export function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

/**
 * Extract the `path` argument from a paired `read` tool call, when the result
 * is a `read` result carrying a string path. Returns `undefined` otherwise.
 * Shared primitive for read-targeted protection matchers (skills, plans, …).
 */
export function getReadToolPath({ toolResult, toolCall }: ProtectedToolContext): string | undefined {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	const path = (toolCall.arguments as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false;
}

	/** Tool names whose results carry on-screen OCR text (eye/screenshot/verify).
	 *  The newest N such results are protected from pruning — the text layer is
	 *  the only copy once the temp image file is deleted, and sweeping it is
	 *  what forces "please paste the email" fallbacks. Older OCR results still
	 *  prune normally; the watch transcript (the book) is the durable archive. */
	export const OCR_TOOL_NAMES = ["desktop_control", "camera_control"] as const;

	/** How many of the most recent OCR tool results to protect. Newest-first. */
	export const OCR_PROTECTED_RECENT_COUNT = 3;

	/** True when this tool result carries OCR text in its details payload
	 *  (eye glance, screenshot, or verify frame — all stamp ocrText). */
	export function isOcrToolResult(context: ProtectedToolContext): boolean {
		if (context.toolResult.toolName !== "desktop_control" && context.toolResult.toolName !== "camera_control") return false;
		const details = context.toolResult.details as { ocrText?: unknown; liveEye?: unknown } | undefined;
		if (!details || typeof details !== "object") return false;
		return typeof (details as { ocrText?: unknown }).ocrText === "string" || "liveEye" in details;
	}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
