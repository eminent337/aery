import type { BoardStore, ReadOptions } from "../store/board-store";
import type { MemberRegistry } from "../store/member-registry";

export type ReadBoardParams = ReadOptions;

export function createReadBoardTool(deps: {
	boardStore: BoardStore;
	registry?: MemberRegistry;
	callerName: string;
}) {
	return {
		name: "read_board",
		description: "Read recent posts from the swarm blackboard.",
		execute: async (options: ReadBoardParams = {}) => {
			const messages = deps.boardStore.readMessages(options);
			if (deps.registry && messages.length > 0) {
				const latest = messages[messages.length - 1].seq;
				deps.registry.updateMember(deps.callerName, { lastSeqRead: latest });
			}
			return { success: true, messages };
		},
	};
}
