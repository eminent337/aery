export function mapAgentEventToProto(event: any, sessionId: string): any {
	if (event.type === "chunk" || event.type === "text") {
		return {
			session_id: sessionId,
			text_chunk: {
				text: event.text ?? event.content ?? "",
				is_final: event.isFinal ?? false,
			},
		};
	}
	if (event.type === "tool_call" || event.type === "call") {
		return {
			session_id: sessionId,
			tool_call: {
				tool_call_id: event.id ?? event.toolCallId ?? "",
				tool_name: event.name ?? event.toolName ?? "",
				arguments_json: JSON.stringify(event.arguments ?? {}),
			},
		};
	}
	if (event.type === "tool_execution_end" || event.type === "result") {
		return {
			session_id: sessionId,
			tool_result: {
				tool_call_id: event.toolCallId ?? "",
				approved: !event.isError,
				feedback: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {}),
			},
		};
	}
	if (event.type === "usage" || event.type === "stats") {
		return {
			session_id: sessionId,
			status: {
				model: event.model ?? "",
				input_tokens: event.inputTokens ?? event.usage?.input ?? 0,
				output_tokens: event.outputTokens ?? event.usage?.output ?? 0,
				phase: event.phase ?? "thinking",
			},
		};
	}
	return null;
}
