// ─── Lifecycle Event Types ────────────────────────────────────────────────────

/**
 * All named events that Aery emits throughout a session lifecycle.
 * Extensions subscribe to these via `ExtensionAPI.on()`.
 */
export type AeryEventName =
	| "session_start"
	| "session_shutdown"
	| "session_before_compact"
	| "session_compact"
	| "before_agent_start"
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "input"
	| "context"
	| "before_provider_request"
	| "after_provider_response"
	| "tool_call"
	| "tool_result"
	| "tool_execution_start"
	| "tool_execution_end"
	| "resources_discover";

/** A strongly-typed event envelope emitted by the Aery runtime */
export interface AeryEvent<T = unknown> {
	/** The lifecycle event name */
	name: AeryEventName;
	/** Payload specific to this event type */
	data: T;
	/** ID of the session this event belongs to */
	sessionId: string;
	/** Unix epoch millisecond timestamp */
	timestamp: number;
}

/** Handler function signature for any Aery lifecycle event */
export type AeryEventHandler<T = unknown> = (event: AeryEvent<T>) => void | Promise<void>;
