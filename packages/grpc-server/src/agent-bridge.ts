import { type AgentSession, createAgentSession } from "@aryee337/aery/sdk";
import { mapAgentEventToProto } from "./streaming";

interface SessionWrap {
	session: AgentSession;
	unsubscribe: () => void;
}

export class AgentBridge {
	async handleStream(call: any): Promise<void> {
		// Per-stream session map — isolated to this stream, not shared across clients
		const streamSessions = new Map<string, SessionWrap>();

		const cleanup = () => {
			for (const wrap of streamSessions.values()) {
				wrap.unsubscribe();
				wrap.session.abort();
				void wrap.session.dispose?.();
			}
			streamSessions.clear();
		};

		call.on("error", (err: Error) => {
			// Absorb CANCELLED errors from client disconnect; log others
			const code = (err as any).code;
			if (code !== "CANCELLED" && code !== 1) {
				console.error("[grpc agent-bridge] stream error:", err);
			}
			cleanup();
		});

		call.on("end", () => {
			cleanup();
			call.end();
		});

		call.on("data", async (msg: any) => {
			const sessionId = msg.session_id;
			if (!sessionId) {
				call.write({ error: { code: "INVALID_SESSION", message: "session_id is required" } });
				return;
			}

			let wrap = streamSessions.get(sessionId);
			if (!wrap) {
				try {
					const { session } = await createAgentSession({
						cwd: process.cwd(),
					});
					const unsubscribe = session.subscribe((event: any) => {
						const protoMsg = mapAgentEventToProto(event, sessionId);
						if (protoMsg) {
							try {
								call.write(protoMsg);
							} catch {
								// Stream may already be closed; ignore write errors
							}
						}
					});
					wrap = { session, unsubscribe };
					streamSessions.set(sessionId, wrap);
				} catch (err: any) {
					call.write({ session_id: sessionId, error: { code: "INIT_FAILED", message: err.message } });
					return;
				}
			}

			if (msg.text) {
				try {
					await wrap.session.prompt(msg.text.content);
					call.write({ session_id: sessionId, done: { session_id: sessionId } });
				} catch (err: any) {
					call.write({ session_id: sessionId, error: { code: "PROMPT_FAILED", message: err.message } });
				}
			}
		});
	}
}
