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

import * as z from "zod/v4";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import { AgentRegistry } from "../registry/agent-registry";
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
export function drainPendingMessages(
	recipientId: string,
): Array<{ from: string; message: string; timestamp: number }> {
	const msgs = pendingMessages.get(recipientId) ?? [];
	pendingMessages.delete(recipientId);
	return msgs;
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
		const registry = AgentRegistry.global();
		const recipientRef = registry.get(Recipient);

		if (!recipientRef) {
			// Queue message for delivery when/if the recipient registers later
			const queue = pendingMessages.get(Recipient) ?? [];
			queue.push({ from: senderId, message: Message, timestamp: Date.now() });
			pendingMessages.set(Recipient, queue);

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

		// If the recipient has a live session with sendCustomMessage support, use it
		const recipientSession = recipientRef.session as any;
		if (recipientSession && typeof recipientSession.sendCustomMessage === "function") {
			try {
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

				return {
					content: [
						{
							type: "text",
							text: `Message delivered to '${Recipient}' (${recipientRef.displayName}).`,
						},
					],
					details: { recipient: Recipient, delivered: true, from: senderId },
				};
			} catch (err: any) {
				// Fall through to pending queue on delivery failure
			}
		}

		// Recipient exists but has no live session — queue for later delivery
		const queue = pendingMessages.get(Recipient) ?? [];
		queue.push({ from: senderId, message: Message, timestamp: Date.now() });
		pendingMessages.set(Recipient, queue);

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
