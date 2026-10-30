/**
 * Tests for InvokeSubagentTool and SendMessageTool — agy subagent orchestration.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { InvokeSubagentTool } from "../../src/tools/invoke-subagent";
import { SendMessageTool, drainPendingMessages } from "../../src/tools/send-message";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content[0];
	return c?.type === "text" && c.text ? c.text : "";
}

describe("InvokeSubagentTool", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("has the correct name and approval level", () => {
		const tool = new InvokeSubagentTool();
		expect(tool.name).toBe("invoke_subagent");
		expect(tool.approval).toBe("exec");
		expect(tool.loadMode).toBe("discoverable");
	});

	it("returns a conversationId for a built-in type", async () => {
		const tool = new InvokeSubagentTool();
		const result = await tool.execute("call-1", {
			TypeName: "research",
			Role: "Codebase Researcher",
			Prompt: "Find all usages of AgentRegistry",
		});

		const text = getText(result as any);
		expect(text).toContain("Subagent launched successfully");
		expect(text).toContain("conversationId");

		// Details should include conversationId
		const details = result.details as Record<string, unknown>;
		expect(typeof details.conversationId).toBe("string");
		expect((details.conversationId as string).length).toBeGreaterThan(0);
		expect(details.typeName).toBe("research");
		expect(details.role).toBe("Codebase Researcher");
	});

	it("registers the subagent in the global AgentRegistry", async () => {
		const tool = new InvokeSubagentTool();
		const result = await tool.execute("call-2", {
			TypeName: "self",
			Role: "Autonomous Coder",
			Prompt: "Implement feature X",
			Model: "pro",
			Workspace: "branch",
		});

		const details = result.details as Record<string, unknown>;
		const conversationId = details.conversationId as string;

		const registry = AgentRegistry.global();
		const ref = registry.get(conversationId);
		expect(ref).toBeDefined();
		expect(ref?.kind).toBe("sub");
		expect(ref?.displayName).toContain("self");
	});

	it("works for unknown custom type names (logs as generic sub)", async () => {
		const tool = new InvokeSubagentTool();
		const result = await tool.execute("call-3", {
			TypeName: "my-custom-agent",
			Role: "Custom Agent",
			Prompt: "Do custom work",
		});

		const details = result.details as Record<string, unknown>;
		expect(typeof details.conversationId).toBe("string");
		expect(details.typeName).toBe("my-custom-agent");
	});

	it("applies default model and workspace when not specified", async () => {
		const tool = new InvokeSubagentTool();
		const result = await tool.execute("call-4", {
			TypeName: "research",
			Role: "Researcher",
			Prompt: "Research something",
		});

		const details = result.details as Record<string, unknown>;
		expect(details.model).toBe("inherit");
		expect(details.workspace).toBe("inherit");
	});
});

describe("SendMessageTool", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("has the correct name and approval level", () => {
		const tool = new SendMessageTool();
		expect(tool.name).toBe("send_message");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("discoverable");
	});

	it("queues message when recipient is not registered", async () => {
		const tool = new SendMessageTool();
		const result = await tool.execute("msg-1", {
			Recipient: "nonexistent-agent-id",
			Message: "Hello, agent!",
		});

		const text = getText(result as any);
		expect(text).toContain("queued");
		const details = result.details as Record<string, unknown>;
		expect(details.queued).toBe(true);
	});

	it("drainPendingMessages returns queued messages for a recipient", async () => {
		const tool = new SendMessageTool();
		await tool.execute("msg-2", {
			Recipient: "my-subagent-9999",
			Message: "First message",
		});
		await tool.execute("msg-3", {
			Recipient: "my-subagent-9999",
			Message: "Second message",
		});

		const drained = drainPendingMessages("my-subagent-9999");
		expect(drained).toHaveLength(2);
		expect(drained[0].message).toBe("First message");
		expect(drained[1].message).toBe("Second message");

		// Draining is destructive
		const drainedAgain = drainPendingMessages("my-subagent-9999");
		expect(drainedAgain).toHaveLength(0);
	});

	it("delivers to registered agent without live session (queues)", async () => {
		// Register an agent without a live session
		const registry = AgentRegistry.global();
		registry.register({
			id: "ResearchAgent-1234",
			displayName: "Research [research]",
			kind: "sub",
			session: null,
			status: "idle",
		});

		const tool = new SendMessageTool();
		const result = await tool.execute("msg-4", {
			Recipient: "ResearchAgent-1234",
			Message: "Please investigate the bug in auth.ts",
		});

		// Should queue since session is null
		const text = getText(result as any);
		expect(text).toContain("queued");
	});

	it("invoke_subagent + send_message round trip works", async () => {
		// Full round trip: invoke → get conversationId → send message
		const invokeTool = new InvokeSubagentTool();
		const sendTool = new SendMessageTool();

		const invokeResult = await invokeTool.execute("invoke-rt", {
			TypeName: "research",
			Role: "Research Agent",
			Prompt: "Explore the codebase",
		});

		const invokeDetails = invokeResult.details as Record<string, unknown>;
		const conversationId = invokeDetails.conversationId as string;

		const sendResult = await sendTool.execute("send-rt", {
			Recipient: conversationId,
			Message: "Please also check the test files",
		});

		// Message should be queued (no live session attached)
		const sendText = getText(sendResult as any);
		expect(sendText).toContain("queued");

		// Drain should return the message
		const drained = drainPendingMessages(conversationId);
		expect(drained).toHaveLength(1);
		expect(drained[0].message).toBe("Please also check the test files");
	});
});
