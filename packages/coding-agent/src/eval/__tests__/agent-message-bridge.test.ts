import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import {
	EVAL_AGENT_MESSAGE_BRIDGE_NAME,
	disposeAgentMessageStore,
	runEvalAgentMessage,
} from "../agent-message-bridge";

function makeSession(): ToolSession {
	return {
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-session",
		getSettings: () => new Settings(),
	} as unknown as ToolSession;
}

describe("runEvalAgentMessage dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAgentMessageStore("test-session");
	});

	it("dispatches send to child mailbox", () => {
		const session = makeSession();
		const result = runEvalAgentMessage({ op: "send", message: "hello", receiverRole: "child", receiverName: "agent-1" }, { session }) as { ok: boolean; delivered: boolean; mailbox: string };

		expect(result.ok).toBe(true);
		expect(result.delivered).toBe(true);
		expect(result.mailbox).toBe("child:agent-1");
	});

	it("dispatches send to parent mailbox", () => {
		const session = makeSession();
		const result = runEvalAgentMessage({ op: "send", message: "reply", receiverRole: "parent" }, { session }) as { ok: boolean; delivered: boolean; mailbox: string };

		expect(result.ok).toBe(true);
		expect(result.delivered).toBe(true);
		expect(result.mailbox).toBe("parent");
	});

	it("dispatches read and drains mailbox", () => {
		const session = makeSession();

		// Send a message first
		runEvalAgentMessage({ op: "send", message: "parent says hi", receiverRole: "child", receiverName: "agent-1" }, { session });

		// Read from the child's mailbox
		const result = runEvalAgentMessage({ op: "read", mailbox: "child:agent-1" }, { session }) as { mailbox: string; messages: Array<{ message: string; fromRole: string; fromName?: string; timestamp: number }> };

		expect(result.mailbox).toBe("child:agent-1");
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].message).toBe("parent says hi");
		expect(result.messages[0].fromRole).toBe("parent");

		// Should be drained
		const result2 = runEvalAgentMessage({ op: "read", mailbox: "child:agent-1" }, { session }) as { messages: unknown[] };
		expect((result2 as { messages: unknown[] }).messages).toEqual([]);
	});

	it("dispatches list and returns mailboxes", () => {
		const session = makeSession();

		// Send two messages to different mailboxes
		runEvalAgentMessage({ op: "send", message: "msg1", receiverRole: "child", receiverName: "a" }, { session });
		runEvalAgentMessage({ op: "send", message: "msg2", receiverRole: "child", receiverName: "b" }, { session });

		const result = runEvalAgentMessage({ op: "list" }, { session }) as { mailboxes: Array<{ mailbox: string; messageCount: number }> };

		expect(result.mailboxes).toHaveLength(2);
		expect(result.mailboxes.map(m => m.mailbox)).toContain("child:a");
		expect(result.mailboxes.map(m => m.mailbox)).toContain("child:b");
		expect(result.mailboxes.find(m => m.mailbox === "child:a")!.messageCount).toBe(1);
		expect(result.mailboxes.find(m => m.mailbox === "child:b")!.messageCount).toBe(1);
	});

	it("throws on empty message", () => {
		const session = makeSession();
		expect(() => runEvalAgentMessage({ op: "send", message: "", receiverRole: "parent" }, { session })).toThrow("message must be a non-empty string");
	});

	it("throws on invalid op", () => {
		const session = makeSession();
		expect(() => runEvalAgentMessage({ op: "foo" as "send", message: "x" }, { session })).toThrow("Invalid option");
	});
});

describe("rlm() + agent_message integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAgentMessageStore("test-session-integration");
	});

	it("parent sends to child, child reads and replies", () => {
		const session = makeSession();

		// Parent sends to child
		const sendResult = runEvalAgentMessage(
			{ op: "send", message: "task assignment", receiverRole: "child", receiverName: "worker-1" },
			{ session },
		) as { ok: boolean; mailbox: string };
		expect(sendResult.ok).toBe(true);
		expect(sendResult.mailbox).toBe("child:worker-1");

		// Child reads its mailbox
		const readResult = runEvalAgentMessage(
			{ op: "read", mailbox: "child:worker-1" },
			{ session },
		) as { messages: Array<{ message: string }> };
		expect(readResult.messages).toHaveLength(1);
		expect(readResult.messages[0].message).toBe("task assignment");

		// Child replies to parent
		const replyResult = runEvalAgentMessage(
			{ op: "send", message: "done", receiverRole: "parent" },
			{ session },
		) as { ok: boolean; mailbox: string };
		expect(replyResult.mailbox).toBe("parent");

		// Parent reads parent mailbox
		const parentRead = runEvalAgentMessage(
			{ op: "read", mailbox: "parent" },
			{ session },
		) as { messages: Array<{ message: string }> };
		expect(parentRead.messages).toHaveLength(1);
		expect(parentRead.messages[0].message).toBe("done");
	});
});
