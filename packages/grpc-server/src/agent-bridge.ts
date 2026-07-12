import { createAgentSession } from "@aryee337/aery/sdk";
import { mapAgentEventToProto } from "./streaming";

export class AgentBridge {
	#sessions = new Map<string, any>();

	async handleStream(call: any): Promise<void> {
		call.on("data", async (msg: any) => {
			const sessionId = msg.session_id;
			if (!sessionId) {
				call.write({ error: { code: "INVALID_SESSION", message: "session_id is required" } });
				return;
			}

			let sessionWrap = this.#sessions.get(sessionId);
			if (!sessionWrap) {
				try {
					const { session } = await createAgentSession({
						cwd: process.cwd(),
					});
					sessionWrap = {
						session,
						unsubscribe: session.subscribe((event: any) => {
							const protoMsg = mapAgentEventToProto(event, sessionId);
							if (protoMsg) {
								call.write(protoMsg);
							}
						}),
					};
					this.#sessions.set(sessionId, sessionWrap);
				} catch (err: any) {
					call.write({ session_id: sessionId, error: { code: "INIT_FAILED", message: err.message } });
					return;
				}
			}

			if (msg.text) {
				try {
					await sessionWrap.session.prompt(msg.text.content);
					call.write({ session_id: sessionId, done: { session_id: sessionId } });
				} catch (err: any) {
					call.write({ session_id: sessionId, error: { code: "PROMPT_FAILED", message: err.message } });
				}
			}
		});

		call.on("end", () => {
			for (const sessionWrap of this.#sessions.values()) {
				sessionWrap.unsubscribe();
				sessionWrap.session.dispose?.();
			}
			this.#sessions.clear();
			call.end();
		});
	}
}
