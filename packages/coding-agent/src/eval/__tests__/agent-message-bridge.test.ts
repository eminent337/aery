import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import {
	EVAL_AGENT_MESSAGE_BRIDGE_NAME,
	disposeAgentMessageStore,
	runEvalAgentMessage,
	runEvalAgentMessageList,
	runEvalAgentMessageRead,
} from "../agent-message-bridge";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionId: () => "test-session",
	} as unknown as ToolSession;
}

describe("runEvalAgentMessage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a message to a subagent", () => {
		const session = makeSession();
		const result = runEvalAgentMessage(
			{ message: "hello", receiverRole: "child", receiverName: "agent-1" },
			{ session },
		);

		expect(result).toEqual({ ok: true, delivered: true });
	});

	it("sends a message to parent", () => {
		const session = makeSession();
		const result = runEvalAgentMessage(
			{ message: "reply", receiverRole: "parent" },
			{ session },
		);

		expect(result).toEqual({ ok: true, delivered: true });
	});

	it("throws for invalid arguments", () => {
		const session = makeSession();
		expect(() =>
			runEvalAgentMessage({ message: "", receiverRole: "parent" }, { session }),
		).toThrow("message must be a non-empty string");
	});
});

describe("runEvalAgentMessageRead", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAgentMessageStore("test-session-read");
	});

	it("reads messages for a subagent", () => {
		const session = makeSession();
		// Override session ID for this test
		vi.spyOn(session, "getSessionId").mockReturnValue("test-session-read");

		// Send a message
		runEvalAgentMessage(
			{ message: "parent says hi", receiverRole: "child", receiverName: "agent-1" },
			{ session },
		);

		// Read messages
		const messages = runEvalAgentMessageRead({ subagentId: "agent-1" }, { session });
		expect(messages).toHaveLength(1);
		expect(messages[0].message).toBe("parent says hi");
		expect(messages[0].senderRole).toBe("parent");

		// Queue should be cleared
		const messages2 = runEvalAgentMessageRead({ subagentId: "agent-1" }, { session });
		expect(messages2).toHaveLength(0);
	});

	it("returns empty array when no messages", () => {
		const session = makeSession();
		vi.spyOn(session, "getSessionId").mockReturnValue("test-session-read");

		const messages = runEvalAgentMessageRead({ subagentId: "agent-1" }, { session });
		expect(messages).toEqual([]);
	});
});

describe("runEvalAgentMessageList", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAgentMessageStore("test-session-list");
	});

	it("lists active subagent queues", () => {
		const session = makeSession();
		vi.spyOn(session, "getSessionId").mockReturnValue("test-session-list");

		// Send messages to two subagents
		runEvalAgentMessage(
			{ message: "msg1", receiverRole: "child", receiverName: "agent-1" },
			{ session },
		);
		runEvalAgentMessage(
			{ message: "msg2", receiverRole: "child", receiverName: "agent-1" },
			{ session },
		);
		runEvalAgentMessage(
			{ message: "msg3", receiverRole: "child", receiverName: "agent-2" },
			{ session },
		);

		const queues = runEvalAgentMessageList({}, { session });
		expect(queues).toHaveLength(2);
		expect(queues.find(q => q.subagentId === "agent-1")?.messageCount).toBe(2);
		expect(queues.find(q => q.subagentId === "agent-2")?.messageCount).toBe(1);
	});

	it("returns empty array when no queues", () => {
		const session = makeSession();
		vi.spyOn(session, "getSessionId").mockReturnValue("test-session-list");

		const queues = runEvalAgentMessageList({}, { session });
		expect(queues).toEqual([]);
	});
});

describe("disposeAgentMessageStore", () => {
	it("clears all message stores for a session", () => {
		const session = makeSession();
		vi.spyOn(session, "getSessionId").mockReturnValue("test-session-dispose");

		runEvalAgentMessage(
			{ message: "msg", receiverRole: "child", receiverName: "agent-1" },
			{ session },
		);

		disposeAgentMessageStore("test-session-dispose");

		const queues = runEvalAgentMessageList({}, { session });
		expect(queues).toEqual([]);
	});
});

describe("rlm() + agent_message integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAgentMessageStore("test-session-integration");
	});

	it("simulates parent-child messaging flow", async () => {
		const session = makeSession();
		vi.spyOn(session, "getSessionId").mockReturnValue("test-session-integration");

		// Parent sends message to child-agent
		const handle = await runEvalAgentMessage(
			{ message: "start task", receiverRole: "child", receiverName: "child-agent" },
			{ session },
		);
		expect(handle.ok).toBe(true);

		// Child reads its queue
		const childMessages = runEvalAgentMessageRead({ subagentId: "child-agent" }, { session });
		expect(childMessages).toHaveLength(1);
		expect(childMessages[0].message).toBe("start task");

		// Child sends reply to parent (stored in default queue since no receiverName)
		const reply = runEvalAgentMessage(
			{ message: "done", receiverRole: "parent" },
			{ session },
		);
		expect(reply.ok).toBe(true);

		// Parent reads from default queue (where child reply went)
		const parentMessages = runEvalAgentMessageRead({ subagentId: "default" }, { session });
		expect(parentMessages).toHaveLength(1);
		expect(parentMessages[0].message).toBe("done");
	});
});
