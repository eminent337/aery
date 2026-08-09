/**
 * Host-side handler for the eval `agent_message` messaging system.
 *
 * Enables bidirectional communication between parent and child agents
 * spawned via rlm(). Messages are stored in a session-scoped message bus.
 */
import * as z from "zod/v4";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `agent_message` helper. */
export const EVAL_AGENT_MESSAGE_BRIDGE_NAME = "__agent_message__";

const agentMessageArgsSchema = z.object({
	message: z.string().min(1, "message must be a non-empty string"),
	receiverRole: z.enum(["parent", "child"]).default("parent"),
	receiverName: z.string().optional(),
});

interface EvalAgentMessageArgs {
	message: string;
	receiverRole: "parent" | "child";
	receiverName?: string;
}

export interface EvalAgentMessageBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalAgentMessageResult {
	ok: boolean;
	delivered: boolean;
}

function parseAgentMessageArgs(args: unknown): EvalAgentMessageArgs {
	const parsed = agentMessageArgsSchema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		throw new ToolError(`agent_message.send() received invalid arguments: ${where}${issue?.message ?? "bad input"}`);
	}
	return parsed.data;
}

/**
 * Message queue for a single session.
 * Keys are subagent IDs, values are arrays of incoming messages.
 */
interface MessageQueue {
	subagentId: string;
	messages: Array<{
		fromRole: "parent" | "child";
		fromName?: string;
		message: string;
		timestamp: number;
	}>;
}

/**
 * Session-scoped message store.
 * In production, this would be part of ToolSession or a global registry.
 * For now, we use a module-level Map keyed by session ID.
 */
const messageStores = new Map<string, Map<string, MessageQueue>>();

/**
 * Send a message from parent to child or child to parent.
 * Returns immediately; message is queued for the receiver.
 */
export function runEvalAgentMessage(args: unknown, options: EvalAgentMessageBridgeOptions): EvalAgentMessageResult {
	const parsed = parseAgentMessageArgs(args);
	const sessionId = options.session.getSessionId?.() ?? "unknown";

	// Get or create the session's message store
	if (!messageStores.has(sessionId)) {
		messageStores.set(sessionId, new Map());
	}
	const sessionStore = messageStores.get(sessionId)!;

	// Determine target subagent
	// In a full implementation, receiverName would identify a specific subagent
	const targetSubagentId = parsed.receiverName ?? "default";

	// Create or get the queue for this subagent
	if (!sessionStore.has(targetSubagentId)) {
		sessionStore.set(targetSubagentId, {
			subagentId: targetSubagentId,
			messages: [],
		});
	}
	const queue = sessionStore.get(targetSubagentId)!;

	// Queue the message
	queue.messages.push({
		fromRole: parsed.receiverRole === "parent" ? "child" : "parent",
		fromName: parsed.receiverName,
		message: parsed.message,
		timestamp: Date.now(),
	});

	options.emitStatus?.({
		op: "agent_message",
		action: "sent",
		toRole: parsed.receiverRole,
		toName: targetSubagentId,
		messageLength: parsed.message.length,
	});

	return { ok: true, delivered: true };
}

/**
 * Read messages sent to the current agent from its parent.
 * Returns all queued messages and clears the queue.
 */
export function runEvalAgentMessageRead(args: unknown, options: EvalAgentMessageBridgeOptions): Array<{
	message: string;
	senderRole: string;
	senderName?: string;
	timestamp: number;
}> {
	const sessionId = options.session.getSessionId?.() ?? "unknown";
	const subagentId = (args as { subagentId?: string })?.subagentId;

	if (!subagentId) {
		return [];
	}

	const sessionStore = messageStores.get(sessionId);
	if (!sessionStore) {
		return [];
	}

	const queue = sessionStore.get(subagentId);
	if (!queue) {
		return [];
	}

	// Return and clear the queue
	const messages = queue.messages;
	queue.messages = [];

	return messages.map(m => ({
		message: m.message,
		senderRole: m.fromRole,
		senderName: m.fromName,
		timestamp: m.timestamp,
	}));
}

/**
 * List all active subagent message queues for a session.
 */
export function runEvalAgentMessageList(_args: unknown, options: EvalAgentMessageBridgeOptions): Array<{
	subagentId: string;
	messageCount: number;
}> {
	const sessionId = options.session.getSessionId?.() ?? "unknown";
	const sessionStore = messageStores.get(sessionId);

	if (!sessionStore) {
		return [];
	}

	return Array.from(sessionStore.entries()).map(([subagentId, queue]) => ({
		subagentId,
		messageCount: queue.messages.length,
	}));
}

/**
 * Clean up message store for a session (called on session close).
 */
export function disposeAgentMessageStore(sessionId: string): void {
	messageStores.delete(sessionId);
}
