/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * The Hindsight retain/recall API only takes flat `{role, content}` records,
 * so we drop tool calls, tool results, bash execution wrappers, custom
 * messages, and anything else that isn't a primary conversation turn. Each
 * surviving message's `TextContent` parts are joined with newlines.
 */

import type { AssistantMessage } from "@aryee337/aery-ai";
import type { SessionEntry } from "../session/session-manager";
import type { HindsightMessage } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. - they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function extractMessages(
	sessionManager: ReadonlySessionManagerLike,
	maxTurns?: number,
): HindsightMessage[] {
	const entries = sessionManager.getEntries();
	if (entries.length === 0) return [];

	// Fast reverse scan when only the most recent N turns are needed
	if (typeof maxTurns === "number" && maxTurns > 0) {
		const messages: HindsightMessage[] = [];
		let userTurnsSeen = 0;

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
			if (text.length === 0) continue;

			messages.unshift({ role, content: text });
			if (role === "user") {
				userTurnsSeen++;
				if (userTurnsSeen >= maxTurns) {
					break;
				}
			}
		}
		return messages;
	}

	const messages: HindsightMessage[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
		if (text.length === 0) continue;
		messages.push({ role, content: text });
	}

	return messages;
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}
