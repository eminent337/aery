import type { BoardStore } from "../store/board-store";
import type { WakeEngine } from "../wake/wake-engine";

export interface PostMessageParams {
	content: string;
	channel?: string;
	mentions?: string[];
}

export function createPostMessageTool(deps: {
	boardStore: BoardStore;
	wakeEngine: WakeEngine;
	callerName: string;
}) {
	return {
		name: "post_message",
		description: "Post a message or question to the swarm blackboard.",
		execute: async (params: PostMessageParams) => {
			const msg = deps.boardStore.appendMessage({
				from: deps.callerName,
				content: params.content,
				channel: params.channel,
				mentions: params.mentions,
			});
			deps.wakeEngine.notifyMessage(msg);
			return { success: true, message: msg };
		},
	};
}
