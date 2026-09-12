import type { AgentMessage } from "@aryee337/aery-core";
import type { ImageContent } from "@aryee337/aery-ai";
import { type CustomMessage, readQueueChipText } from "./messages";

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return undefined;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images: ImageContent[] = [];
	for (const part of message.content) {
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			images.push(part);
		}
	}
	return images.length > 0 ? images : undefined;
}

/** Whether a queued message should count toward the queue UI / pending gate. */
export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

/** Whether queued content was authored by the user and can be restored to the editor. */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Human-readable text shown for a queued-message chip. Custom messages carry
 *  an explicit `__queueChipText` on their details (set by the skill/command
 *  path); user messages fall back to their first text block, or "[Image]". */
export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText((message as CustomMessage).details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}