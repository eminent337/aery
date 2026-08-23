/**
 * Event-sourced session log — append-only event store for Aery sessions.
 *
 * Inspired by DeepSeek Harness's session log where model-visible ⟺ logged.
 * Every action in a session is an immutable event. The event log is the
 * single source of truth; messages, UI state, and model context are all
 * derived from events.
 */

import type { AgentMessage } from "@aryee337/aery-core";

export interface BaseEvent {
	id: string;
	type: string;
	timestamp: number;
	sessionId: string;
	payload: Record<string, unknown>;
}

export interface UserMessageEvent extends BaseEvent {
	type: "user/message";
	payload: {
		text: string;
		attribution?: string;
	};
}

export interface AssistantMessageEvent extends BaseEvent {
	type: "assistant/message";
	payload: {
		message: Record<string, unknown>;
		model?: string;
		usage?: { input: number; output: number };
	};
}

export interface AssistantThinkingEvent extends BaseEvent {
	type: "assistant/thinking";
	payload: {
		text: string;
		signature?: string;
	};
}

export interface ToolCallEvent extends BaseEvent {
	type: "tool/call";
	payload: {
		callId: string;
		toolName: string;
		args: Record<string, unknown>;
	};
}

export interface ToolResultEvent extends BaseEvent {
	type: "tool/result";
	payload: {
		callId: string;
		toolName: string;
		content: unknown;
		success: boolean;
	};
}

export interface ToolErrorEvent extends BaseEvent {
	type: "tool/error";
	payload: {
		callId: string;
		toolName: string;
		error: string;
	};
}

export interface SystemEvent extends BaseEvent {
	type: "system/session-start" | "system/session-end" | "system/turn-start" | "system/turn-end";
	payload: {
		reason?: string;
	};
}

export type SessionEvent =
	| UserMessageEvent
	| AssistantMessageEvent
	| AssistantThinkingEvent
	| ToolCallEvent
	| ToolResultEvent
	| ToolErrorEvent
	| SystemEvent;

/**
 * Derive AgentMessage[] from events. Uses `as unknown as AgentMessage` because
 * events are serialized to JSON and lose the strict type info of the original
 * AgentMessage (which includes api, provider, timestamp, etc.). We only need
 * role/content/tool_calls for the model to understand the conversation.
 */
export function deriveMessages(events: SessionEvent[]): AgentMessage[] {
	const messages: AgentMessage[] = [];

	for (const event of events) {
		switch (event.type) {
			case "user/message": {
				messages.push({
					role: "user",
					content: [{ type: "text", text: event.payload.text }],
					attribution: event.payload.attribution,
				} as unknown as AgentMessage);
				break;
			}
			case "assistant/message": {
				const msg = event.payload.message;
				messages.push({
					role: "assistant",
					content: msg.content,
					tool_calls: msg.tool_calls,
					model: event.payload.model,
					usage: event.payload.usage,
				} as unknown as AgentMessage);
				break;
			}
			case "tool/result": {
				messages.push({
					role: "toolResult",
					tool_call_id: event.payload.callId,
					content: event.payload.content,
					tool_name: event.payload.toolName,
				} as unknown as AgentMessage);
				break;
			}
			case "tool/error": {
				messages.push({
					role: "toolResult",
					tool_call_id: event.payload.callId,
					content: [{ type: "text", text: `Error: ${event.payload.error}` }],
					tool_name: event.payload.toolName,
				} as unknown as AgentMessage);
				break;
			}
			case "assistant/thinking":
			case "system/session-start":
			case "system/session-end":
			case "system/turn-start":
			case "system/turn-end":
				break;
		}
	}

	return messages;
}

export function findEvent(events: SessionEvent[], eventId: string): SessionEvent | undefined {
	return events.find(e => e.id === eventId);
}

export function getToolCallEvents(
	events: SessionEvent[],
	callId: string,
): { call?: ToolCallEvent; result?: ToolResultEvent; error?: ToolErrorEvent } {
	const result: { call?: ToolCallEvent; result?: ToolResultEvent; error?: ToolErrorEvent } = {};
	for (const event of events) {
		if (event.type === "tool/call" && event.payload.callId === callId) {
			result.call = event as ToolCallEvent;
		} else if (event.type === "tool/result" && event.payload.callId === callId) {
			result.result = event as ToolResultEvent;
		} else if (event.type === "tool/error" && event.payload.callId === callId) {
			result.error = event as ToolErrorEvent;
		}
	}
	return result;
}

export function getTurnToolCalls(events: SessionEvent[], turnStartEventId: string): ToolCallEvent[] {
	const startIdx = events.findIndex(e => e.id === turnStartEventId);
	if (startIdx === -1) return [];

	const calls: ToolCallEvent[] = [];
	for (let i = startIdx + 1; i < events.length; i++) {
		const event = events[i];
		if (event.type === "system/turn-end") break;
		if (event.type === "tool/call") {
			calls.push(event as ToolCallEvent);
		}
	}
	return calls;
}
