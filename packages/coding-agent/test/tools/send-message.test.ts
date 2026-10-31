/**
 * Integration tests for SendMessageTool — bidirectional inter-agent messaging.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { clearPendingMessagesForTests, drainPendingMessages, SendMessageTool } from "../../src/tools/send-message";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content[0];
	return c?.type === "text" && c.text ? c.text : "";
}

describe("SendMessageTool - Bidirectional Messaging", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		clearPendingMessagesForTests();
	});

	it("delivers message from parent to live child session with attribution 'user'", async () => {
		const sendCustomMessageMock = mock(async () => {});
		const mockChildSession: any = {
			sendCustomMessage: sendCustomMessageMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-child-1",
			displayName: "Child Worker [worker]",
			kind: "sub",
			parentId: "parent-session-1",
			session: mockChildSession,
			status: "idle",
		});

		const parentToolSession: any = {
			getAgentId: () => "parent-session-1",
		};
		const tool = new SendMessageTool(parentToolSession);

		const result = await tool.execute("call-1", {
			Recipient: "sub-child-1",
			Message: "Please inspect auth.ts and report findings",
		});

		// Verify return details
		const details = result.details as Record<string, unknown>;
		expect(details.delivered).toBe(true);
		expect(details.recipient).toBe("sub-child-1");
		expect(details.from).toBe("parent-session-1");

		const text = getText(result as any);
		expect(text).toContain("Message delivered to 'sub-child-1'");

		// Verify child's sendCustomMessage invocation
		expect(sendCustomMessageMock).toHaveBeenCalledTimes(1);
		const callArgs = (sendCustomMessageMock.mock.calls as any)[0];
		const messagePayload = callArgs[0];
		const deliveryOptions = callArgs[1];

		expect(messagePayload.customType).toBe("agent_message");
		expect(messagePayload.content).toBe("Please inspect auth.ts and report findings");
		expect(messagePayload.attribution).toBe("user");
		expect(messagePayload.details).toEqual({ from: "parent-session-1" });

		expect(deliveryOptions).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("delivers message from child to parent session (MAIN_AGENT_ID) wrapped in SYSTEM_MESSAGE with attribution 'agent'", async () => {
		const sendCustomMessageMock = mock(async () => {});
		const mockParentSession: any = {
			sendCustomMessage: sendCustomMessageMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main Session",
			kind: "main",
			session: mockParentSession,
			status: "idle",
		});

		registry.register({
			id: "sub-worker-1",
			displayName: "Worker Agent [worker]",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
		});

		const childToolSession: any = {
			getAgentId: () => "sub-worker-1",
		};
		const tool = new SendMessageTool(childToolSession);

		const result = await tool.execute("call-2", {
			Recipient: MAIN_AGENT_ID,
			Message: "Task completed successfully. All tests passing.",
		});

		// Verify return details
		const details = result.details as Record<string, unknown>;
		expect(details.delivered).toBe(true);
		expect(details.recipient).toBe(MAIN_AGENT_ID);
		expect(details.from).toBe("sub-worker-1");

		// Verify parent's sendCustomMessage invocation
		expect(sendCustomMessageMock).toHaveBeenCalledTimes(1);
		const callArgs = (sendCustomMessageMock.mock.calls as any)[0];
		const messagePayload = callArgs[0];
		const deliveryOptions = callArgs[1];

		expect(messagePayload.customType).toBe("agent_message");
		expect(messagePayload.attribution).toBe("agent");
		expect(messagePayload.details).toEqual({
			from: "sub-worker-1",
			priority: "MESSAGE_PRIORITY_HIGH",
		});

		// Verify SYSTEM_MESSAGE formatting
		const content = messagePayload.content as string;
		expect(content).toStartWith("<SYSTEM_MESSAGE>\n[Message] ");
		expect(content).toEndWith("\n</SYSTEM_MESSAGE>");
		expect(content).toContain("sender=sub-worker-1");
		expect(content).toContain("priority=MESSAGE_PRIORITY_HIGH");
		expect(content).toContain("content=Task completed successfully. All tests passing.");
		expect(content).toMatch(/timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

		expect(deliveryOptions).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("delivers message from child to parent session by custom parent ID wrapped in SYSTEM_MESSAGE", async () => {
		const sendCustomMessageMock = mock(async () => {});
		const mockParentSession: any = {
			sendCustomMessage: sendCustomMessageMock,
		};

		const parentId = "parent-coordinator-99";
		const childId = "sub-researcher-42";

		const registry = AgentRegistry.global();
		registry.register({
			id: parentId,
			displayName: "Coordinator [main]",
			kind: "main",
			session: mockParentSession,
			status: "idle",
		});

		registry.register({
			id: childId,
			displayName: "Researcher [research]",
			kind: "sub",
			parentId: parentId,
			session: null,
			status: "running",
		});

		const childToolSession: any = {
			getAgentId: () => childId,
		};
		const tool = new SendMessageTool(childToolSession);

		const result = await tool.execute("call-3", {
			Recipient: parentId,
			Message: "Found 3 relevant files in codebase",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.delivered).toBe(true);

		expect(sendCustomMessageMock).toHaveBeenCalledTimes(1);
		const callArgs = (sendCustomMessageMock.mock.calls as any)[0];
		const messagePayload = callArgs[0];

		expect(messagePayload.customType).toBe("agent_message");
		expect(messagePayload.attribution).toBe("agent");
		expect(messagePayload.details).toEqual({
			from: childId,
			priority: "MESSAGE_PRIORITY_HIGH",
		});

		const content = messagePayload.content as string;
		expect(content).toStartWith("<SYSTEM_MESSAGE>\n[Message] ");
		expect(content).toEndWith("\n</SYSTEM_MESSAGE>");
		expect(content).toContain(`sender=${childId}`);
		expect(content).toContain("priority=MESSAGE_PRIORITY_HIGH");
		expect(content).toContain("content=Found 3 relevant files in codebase");
	});

	it("delivers message to parent session using 'parent' alias", async () => {
		const sendCustomMessageMock = mock(async () => {});
		const mockParentSession: any = {
			sendCustomMessage: sendCustomMessageMock,
		};

		const parentId = "parent-lead-01";
		const childId = "sub-coder-01";

		const registry = AgentRegistry.global();
		registry.register({
			id: parentId,
			displayName: "Lead Agent [main]",
			kind: "main",
			session: mockParentSession,
			status: "idle",
		});

		registry.register({
			id: childId,
			displayName: "Coder [self]",
			kind: "sub",
			parentId: parentId,
			session: null,
			status: "running",
		});

		const childToolSession: any = {
			getAgentId: () => childId,
		};
		const tool = new SendMessageTool(childToolSession);

		const result = await tool.execute("call-alias", {
			Recipient: "parent",
			Message: "Work completed successfully via parent alias",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.delivered).toBe(true);

		expect(sendCustomMessageMock).toHaveBeenCalledTimes(1);
		const callArgs = (sendCustomMessageMock.mock.calls as any)[0];
		const messagePayload = callArgs[0];

		expect(messagePayload.customType).toBe("agent_message");
		expect(messagePayload.attribution).toBe("agent");
		expect(messagePayload.details).toEqual({
			from: childId,
			priority: "MESSAGE_PRIORITY_HIGH",
		});

		const content = messagePayload.content as string;
		expect(content).toStartWith("<SYSTEM_MESSAGE>\n[Message] ");
		expect(content).toContain("priority=MESSAGE_PRIORITY_HIGH");
		expect(content).toContain("content=Work completed successfully via parent alias");
	});

	it("delivers peer-to-peer message between subagents without SYSTEM_MESSAGE wrapping", async () => {
		const sendCustomMessageMock = mock(async () => {});
		const mockPeer2Session: any = {
			sendCustomMessage: sendCustomMessageMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-peer-1",
			displayName: "Peer 1 [worker]",
			kind: "sub",
			parentId: "parent-agent",
			session: null,
			status: "running",
		});

		registry.register({
			id: "sub-peer-2",
			displayName: "Peer 2 [worker]",
			kind: "sub",
			parentId: "parent-agent",
			session: mockPeer2Session,
			status: "idle",
		});

		const peer1ToolSession: any = {
			getAgentId: () => "sub-peer-1",
		};
		const tool = new SendMessageTool(peer1ToolSession);

		const result = await tool.execute("call-4", {
			Recipient: "sub-peer-2",
			Message: "Can you review my diff?",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.delivered).toBe(true);

		expect(sendCustomMessageMock).toHaveBeenCalledTimes(1);
		const callArgs = (sendCustomMessageMock.mock.calls as any)[0];
		const messagePayload = callArgs[0];

		// Should NOT be wrapped in SYSTEM_MESSAGE
		expect(messagePayload.content).toBe("Can you review my diff?");
		expect(messagePayload.attribution).toBe("user");
		expect(messagePayload.details).toEqual({ from: "sub-peer-1" });
	});

	it("falls back to pending queue when recipient is registered without live session", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-offline-agent",
			displayName: "Offline Worker [worker]",
			kind: "sub",
			parentId: "parent-1",
			session: null,
			status: "idle",
		});

		const tool = new SendMessageTool();
		const result = await tool.execute("call-5", {
			Recipient: "sub-offline-agent",
			Message: "Work on this when you wake up",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.queued).toBe(true);
		expect(details.recipientStatus).toBe("idle");

		const text = getText(result as any);
		expect(text).toContain("Message queued for 'sub-offline-agent'");

		// Verify pending queue has the message
		const pending = drainPendingMessages("sub-offline-agent");
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toBe("Work on this when you wake up");
	});

	it("falls back to pending queue when recipient is not registered", async () => {
		const tool = new SendMessageTool();
		const result = await tool.execute("call-6", {
			Recipient: "unregistered-agent-id",
			Message: "Hello unknown agent",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.queued).toBe(true);

		const text = getText(result as any);
		expect(text).toContain("Message queued for delivery to 'unregistered-agent-id' (not currently registered)");

		const pending = drainPendingMessages("unregistered-agent-id");
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toBe("Hello unknown agent");
	});

	it("falls back gracefully to pending queue when recipientSession.sendCustomMessage throws", async () => {
		const failingSession: any = {
			sendCustomMessage: mock(async () => {
				throw new Error("Session transport connection aborted");
			}),
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-crashing-agent",
			displayName: "Crashing Worker [worker]",
			kind: "sub",
			parentId: "parent-1",
			session: failingSession,
			status: "running",
		});

		const tool = new SendMessageTool();
		const result = await tool.execute("call-7", {
			Recipient: "sub-crashing-agent",
			Message: "Message to crash-prone session",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.queued).toBe(true);
		expect(details.recipientStatus).toBe("running");

		const text = getText(result as any);
		expect(text).toContain("Message queued for 'sub-crashing-agent'");

		const pending = drainPendingMessages("sub-crashing-agent");
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toBe("Message to crash-prone session");
	});
});
