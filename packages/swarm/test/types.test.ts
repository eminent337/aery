import { describe, expect, it } from "bun:test";
import type { BoardMessage, MemberState, SwarmMember } from "../src/types";

describe("Swarm Types", () => {
	it("validates SwarmMember schema invariants", () => {
		const member: SwarmMember = {
			name: "worker-1",
			brief: "Inspect codebase architecture",
			model: "gemini-3.5-flash-lite",
			state: "waiting",
			workspace: "share",
			workspacePath: "/tmp/aery-worktrees/worker-1",
			lastSeqRead: 0,
			createdAt: new Date().toISOString(),
		};
		const state: MemberState = member.state;
		expect(member.name).toBe("worker-1");
		expect(state).toBe("waiting");
	});

	it("validates BoardMessage structure", () => {
		const msg: BoardMessage = {
			seq: 1,
			timestamp: new Date().toISOString(),
			from: "coordinator",
			channel: "general",
			mentions: ["worker-1"],
			content: "@worker-1 start your analysis.",
		};
		expect(msg.seq).toBe(1);
		expect(msg.mentions).toContain("worker-1");
	});
});
