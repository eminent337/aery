/**
 * SendMessageTool — Ported from Google Antigravity (agy).
 *
 * Sends a message to another agent (subagent or peer) by conversationId.
 * The recipient is looked up in the global AgentRegistry. If not found,
 * the message is stored as a pending delivery for later retrieval.
 *
 * This tool is the primary communication channel between agents — the
 * parent uses it to follow up with a running subagent; subagents use
 * it to report results back to the parent.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { ToolSession } from "./index";

const sendMessageSchema = z.object({
	Recipient: z
		.string()
		.describe(
			"Conversation ID of the agent to message. Use the conversationId returned by invoke_subagent, or the conversationId shown in manage_subagents list output.",
		),
	Message: z.string().describe("Content of the message to deliver to the recipient agent."),
});

export type SendMessageParams = z.infer<typeof sendMessageSchema>;

/** In-process pending message queue for agents not yet fully wired to a live session. */
const pendingMessages = new Map<string, Array<{ from: string; message: string; timestamp: number }>>();

/**
 * Retrieve and drain all pending messages for an agent ID.
 * Called by agent sessions on startup to receive any messages sent before the session was live.
 */
export function drainPendingMessages(recipientId: string): Array<{ from: string; message: string; timestamp: number }> {
	const msgs = pendingMessages.get(recipientId) ?? [];
	pendingMessages.delete(recipientId);
	return msgs;
}

/**
 * Clear the pending messages queue. Test-only.
 */
export function clearPendingMessagesForTests(): void {
	pendingMessages.clear();
}

export class SendMessageTool implements AgentTool<typeof sendMessageSchema> {
	readonly name = "send_message";
	readonly approval = "read" as const;
	readonly label = "Send Message";
	readonly description =
		"Send a message to another agent, such as a subagent or a peer. Not a channel to the user. Use the conversationId returned by invoke_subagent as the Recipient.";
	readonly parameters = sendMessageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Inter-agent message routing matching agy send_message schema";

	constructor(private readonly session?: ToolSession) {}

	static createIf(session: ToolSession): SendMessageTool {
		return new SendMessageTool(session);
	}

	async execute(
		_toolCallId: string,
		params: SendMessageParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const { Recipient, Message } = params;
		const senderId = this.session?.getAgentId?.() ?? "unknown";

		// Look up recipient in the registry
		const registry = this.session?.agentRegistry ?? AgentRegistry.global();
		const senderRef = senderId !== "unknown" ? registry.get(senderId) : undefined;
		let recipientRef = undefined as ReturnType<typeof registry.get>;

		// Check "parent" alias first before prefix matching in registry to avoid prefix collisions (e.g. "parent-agent")
		if (Recipient.toLowerCase() === "parent") {
			const targetParentId =
				senderRef?.parentId ||
				(this.session as any)?.parentId ||
				(typeof (this.session as any)?.getParentId === "function"
					? (this.session as any).getParentId()
					: undefined) ||
				MAIN_AGENT_ID;
			recipientRef = registry.get(targetParentId);
		} else {
			recipientRef = registry.get(Recipient);
		}

		if (!recipientRef) {
			// Queue message under canonical target ID if known
			const targetQueueKey =
				Recipient.toLowerCase() === "parent" ? (senderRef?.parentId ?? MAIN_AGENT_ID) : Recipient;
			const queue = pendingMessages.get(targetQueueKey) ?? [];
			queue.push({ from: senderId, message: Message, timestamp: Date.now() });
			pendingMessages.set(targetQueueKey, queue);

			return {
				content: [
					{
						type: "text",
						text: `Message queued for delivery to '${Recipient}' (not currently registered). It will be delivered when the agent starts or resumes.`,
					},
				],
				details: { recipient: Recipient, queued: true, from: senderId },
			};
		}

		// Identify whether recipient is a parent session or peer subagent
		const senderParentId = senderRef?.parentId;
		const isParent =
			Recipient === MAIN_AGENT_ID ||
			recipientRef.id === MAIN_AGENT_ID ||
			recipientRef.kind === "main" ||
			Recipient.toLowerCase() === "parent" ||
			(senderParentId !== undefined && (Recipient === senderParentId || recipientRef.id === senderParentId)) ||
			(Boolean((this.session as any)?.parentId) &&
				(Recipient === (this.session as any).parentId || recipientRef.id === (this.session as any).parentId)) ||
			(typeof (this.session as any)?.getParentId === "function" &&
				(Recipient === (this.session as any).getParentId() ||
					recipientRef.id === (this.session as any).getParentId()));

		// If the recipient has a live session with sendCustomMessage support, use it
		const recipientSession = recipientRef.session as any;
		if (recipientSession && typeof recipientSession.sendCustomMessage === "function") {
			try {
				if (isParent) {
					const timestamp = new Date().toISOString();
					const formattedNotice = `<SYSTEM_MESSAGE>\n[Message] timestamp=${timestamp} sender=${senderId} priority=MESSAGE_PRIORITY_HIGH content=${Message}\n</SYSTEM_MESSAGE>`;
					await recipientSession.sendCustomMessage(
						{
							customType: "agent_message",
							content: formattedNotice,
							display: true,
							details: { from: senderId, priority: "MESSAGE_PRIORITY_HIGH" },
							attribution: "agent",
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					if (this.session) {
						(this.session as any).__sentParentMessage = true;
					}
					const senderRegistryRef = senderId !== "unknown" ? registry.get(senderId) : undefined;
					if (senderRegistryRef?.session) {
						(senderRegistryRef.session as any).__sentParentMessage = true;
					}
				} else {
					await recipientSession.sendCustomMessage(
						{
							customType: "agent_message",
							content: Message,
							display: true,
							details: { from: senderId },
							attribution: "user",
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}

				return {
					content: [
						{
							type: "text",
							text: `Message delivered to '${Recipient}' (${recipientRef.displayName}).`,
						},
					],
					details: { recipient: Recipient, delivered: true, from: senderId },
				};
			} catch {
				// Fall through to pending queue on delivery failure
			}
		}

		// Recipient exists but has no live session — queue under canonical ID for later delivery
		const targetQueueKey = recipientRef?.id ?? Recipient;
		const queue = pendingMessages.get(targetQueueKey) ?? [];
		queue.push({ from: senderId, message: Message, timestamp: Date.now() });
		pendingMessages.set(targetQueueKey, queue);

		return {
			content: [
				{
					type: "text",
					text: `Message queued for '${Recipient}' (${recipientRef.displayName}, status: ${recipientRef.status}). It will be delivered when the agent resumes.`,
				},
			],
			details: { recipient: Recipient, queued: true, from: senderId, recipientStatus: recipientRef.status },
		};
	}
}
