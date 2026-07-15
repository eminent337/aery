/**
 * Maps real AgentSessionEvent types (from @aryee337/aery-core) to gRPC proto messages.
 *
 * Real event type strings (verified against agent-session.ts and AgentEvent):
 *   text_delta         — assistant streaming text chunk
 *   tool_execution_start — tool invocation started
 *   tool_execution_end   — tool invocation completed
 *   message_end        — assistant message finished (includes usage)
 */
export function mapAgentEventToProto(event: any, sessionId: string): any {
	// Streaming text delta
	if (event.type === "text_delta") {
		return {
			session_id: sessionId,
			text_chunk: {
				text: event.delta ?? event.text ?? "",
				is_final: false,
			},
		};
	}

	// Tool call started
	if (event.type === "tool_execution_start") {
		return {
			session_id: sessionId,
			tool_call: {
				tool_call_id: event.toolCallId ?? event.id ?? "",
				tool_name: event.toolName ?? event.name ?? "",
				arguments_json: JSON.stringify(event.args ?? event.arguments ?? {}),
			},
		};
	}

	// Tool call completed
	if (event.type === "tool_execution_end") {
		return {
			session_id: sessionId,
			tool_result: {
				tool_call_id: event.toolCallId ?? "",
				approved: !event.isError,
				feedback: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {}),
			},
		};
	}

	// Message finished — emit usage stats if available
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const usage = event.message?.usage;
		if (usage) {
			return {
				session_id: sessionId,
				status: {
					model: usage.model ?? "",
					input_tokens: usage.inputTokens ?? usage.input ?? 0,
					output_tokens: usage.outputTokens ?? usage.output ?? 0,
					phase: "done",
				},
			};
		}
	}

	return null;
}
