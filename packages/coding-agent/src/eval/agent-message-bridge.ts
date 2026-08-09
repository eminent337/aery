/**
 * Host-side handler for the eval `agent_message` messaging system.
 *
 * Enables bidirectional communication between parent and child agents
 * spawned via rlm(). Messages are stored in a session-scoped message bus
 * keyed by mailbox name. Mailboxes follow the convention:
 *   - "parent" — messages from children to the top-level parent agent
 *   - "child:<name>" — messages from the parent to a specific child subagent
 */
import * as z from "zod/v4";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `agent_message` helper. */
export const EVAL_AGENT_MESSAGE_BRIDGE_NAME = "__agent_message__";

/** Op types accepted by the agent_message bridge. */
type AgentMessageOp = "send" | "read" | "list";

	const agentMessageSchema = z.object({
		op: z.enum(["send", "read", "list"]).default("send"),
		message: z.string().min(1, "message must be a non-empty string").optional(),
		receiverRole: z.enum(["parent", "child"]).default("parent"),
		receiverName: z.string().optional(),
		mailbox: z.string().optional(),
	});

interface EvalAgentMessageArgs {
	op: AgentMessageOp;
	message?: string;
	receiverRole: "parent" | "child";
	receiverName?: string;
	mailbox?: string;
}

export interface EvalAgentMessageBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalAgentMessageResult {
	ok: boolean;
	delivered: boolean;
	mailbox: string;
}

export interface EvalAgentMessageReadResult {
	mailbox: string;
	messages: Array<{
		fromRole: "parent" | "child";
		fromName?: string;
		message: string;
		timestamp: number;
	}>;
}

export interface EvalAgentMessageListResult {
	mailboxes: Array<{
		mailbox: string;
		messageCount: number;
	}>;
}

function parseAgentMessageArgs(args: unknown): EvalAgentMessageArgs {
	const parsed = agentMessageSchema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		throw new ToolError(`agent_message received invalid arguments: ${where}${issue?.message ?? "bad input"}`);
	}
	return parsed.data;
}

/**
 * Message queue for a single mailbox.
 */
interface MessageQueue {
	mailbox: string;
	messages: Array<{
		fromRole: "parent" | "child";
		fromName?: string;
		message: string;
		timestamp: number;
	}>;
}

/**
 * Session-scoped message store.
 * Keyed by eval-session-id so parent and child share the same store.
 * Mailboxes within: "parent" for child→parent, "child:<name>" for parent→child.
 */
const messageStores = new Map<string, Map<string, MessageQueue>>();

/**
 * Get or create the message store for the given eval session.
 */
function getStoreForSession(session: ToolSession): Map<string, MessageQueue> {
	const evalId = session.getEvalSessionId?.() ?? session.getSessionId?.() ?? "unknown";
	if (!messageStores.has(evalId)) {
		messageStores.set(evalId, new Map());
	}
	return messageStores.get(evalId)!;
}

/**
 * Resolve the target mailbox for a send operation.
 * - receiverRole "parent" (no receiverName) → "parent"
 * - receiverRole "child", receiverName "foo" → "child:foo"
 */
function resolveMailbox(receiverRole: "parent" | "child", receiverName?: string): string {
	if (receiverRole === "parent") {
		return "parent";
	}
	return `child:${receiverName ?? "unknown"}`;
}

/**
 * Send a message to a mailbox.
 */
function runEvalAgentMessageSend(args: EvalAgentMessageArgs, options: EvalAgentMessageBridgeOptions): EvalAgentMessageResult {
	if (!args.message) {
		throw new ToolError("agent_message.send() requires a non-empty message.");
	}
	const sessionId = options.session.getSessionId?.() ?? "unknown";
	const mailbox = resolveMailbox(args.receiverRole, args.receiverName);
	const store = getStoreForSession(options.session);

	if (!store.has(mailbox)) {
		store.set(mailbox, { mailbox, messages: [] });
	}
	const queue = store.get(mailbox)!;
	queue.messages.push({
		fromRole: args.receiverRole === "parent" ? "child" : "parent",
		fromName: args.receiverName,
		message: args.message,
		timestamp: Date.now(),
	});

	options.emitStatus?.({
		op: "agent_message",
		action: "sent",
		toRole: args.receiverRole,
		toName: args.receiverName,
		mailbox,
		messageLength: args.message.length,
	});

	return { ok: true, delivered: true, mailbox };
}

/**
 * Read (drain) a mailbox. Returns all queued messages and clears the queue.
 */
function runEvalAgentMessageRead(args: EvalAgentMessageArgs, options: EvalAgentMessageBridgeOptions): EvalAgentMessageReadResult {
	const mailbox = args.mailbox ?? "parent";
	const store = getStoreForSession(options.session);

	if (!store.has(mailbox)) {
		return { mailbox, messages: [] };
	}
	const queue = store.get(mailbox)!;
	const messages = queue.messages;
	queue.messages = [];

	return { mailbox, messages: messages.map(m => ({ ...m })) };
}

/**
 * List all mailboxes and their message counts.
 */
function runEvalAgentMessageList(_args: EvalAgentMessageArgs, options: EvalAgentMessageBridgeOptions): EvalAgentMessageListResult {
	const store = getStoreForSession(options.session);
	const mailboxes = Array.from(store.entries()).map(([mailbox, queue]) => ({
		mailbox,
		messageCount: queue.messages.length,
	}));
	return { mailboxes };
}

/**
 * Dispatch entry point for the agent_message bridge.
 */
export function runEvalAgentMessage(args: unknown, options: EvalAgentMessageBridgeOptions): unknown {
	const parsed = parseAgentMessageArgs(args);
	switch (parsed.op ?? "send") {
		case "send":
			return runEvalAgentMessageSend(parsed, options);
		case "read":
			return runEvalAgentMessageRead(parsed, options);
		case "list":
			return runEvalAgentMessageList(parsed, options);
		default:
			throw new ToolError(`Unknown agent_message op: ${parsed.op}`);
	}
}

/**
 * Clean up message store for a session (called on session close).
 */
export function disposeAgentMessageStore(sessionId: string): void {
	messageStores.delete(sessionId);
	// Also clean any entry keyed by the eval-session-id (may differ from session id)
	for (const [key, store] of messageStores.entries()) {
		if (store.size === 0) {
			messageStores.delete(key);
		}
	}
}
