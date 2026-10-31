/**
 * Tests for InvokeSubagentTool and SendMessageTool — agy subagent orchestration.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createMockSubagentSession, SubagentRunner } from "../../src/registry/subagent-runner";
import { InvokeSubagentTool } from "../../src/tools/invoke-subagent";
import { drainPendingMessages, SendMessageTool } from "../../src/tools/send-message";

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

	it("returns a conversationId starting with 'sub-' and log/workspace URIs for a built-in type", async () => {
		const tool = new InvokeSubagentTool();
		const result = await tool.execute("call-1", {
			TypeName: "research",
			Role: "Codebase Researcher",
			Prompt: "Find all usages of AgentRegistry",
		});

		const text = getText(result as any);
		expect(text).toContain("Subagent launched successfully");
		expect(text).toContain("conversationId");

		// Details should include conversationId, logAbsoluteUri, workspaceUris
		const details = result.details as Record<string, unknown>;
		expect(typeof details.conversationId).toBe("string");
		expect(details.conversationId as string).toStartWith("sub-");
		expect(details.conversationId as string).toContain("codebase-researcher");
		expect(details.typeName).toBe("research");
		expect(details.role).toBe("Codebase Researcher");
		expect(typeof details.logAbsoluteUri).toBe("string");
		expect(details.logAbsoluteUri as string).toStartWith("file://");
		expect(Array.isArray(details.workspaceUris)).toBe(true);
		expect((details.workspaceUris as string[]).length).toBeGreaterThan(0);
	});

	it("registers the subagent in global AgentRegistry with status 'running' and live session attached", async () => {
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
		expect(ref?.status).toBe("running");
		expect(ref?.displayName).toContain("self");
		expect(ref?.session).toBeDefined();
		expect(ref?.session).not.toBeNull();
		expect(ref?.sessionFile).toBeDefined();
		expect(typeof ref?.sessionFile).toBe("string");
		expect(ref?.sessionFile?.endsWith(".jsonl")).toBe(true);
	});

	it("supports dependency injection of custom SubagentRunner in constructor and createIf", async () => {
		let launchedOptions: any;
		const customRunner = {
			async launch(opts: any) {
				launchedOptions = opts;
				return {
					conversationId: "sub-mock-custom-123",
					logAbsoluteUri: "file:///mock/logs/sub-mock-custom-123.jsonl",
					workspaceUris: ["/mock/workspace"],
				};
			},
		} as unknown as SubagentRunner;

		const mockSession: any = {
			cwd: "/workspace/project",
			getAgentId: () => "parent-agent-99",
			hasUI: false,
			getSessionFile: () => null,
			getModelState: () => ({ currentModel: "anthropic/claude-3-7-sonnet", available: [] }),
		};

		const toolFromFactory = InvokeSubagentTool.createIf(mockSession, customRunner);
		const result = await toolFromFactory.execute("call-di", {
			TypeName: "self",
			Role: "Autonomous Builder",
			Prompt: "Build the module",
			Model: "pro",
			Workspace: "branch",
		});

		expect(launchedOptions).toBeDefined();
		expect(launchedOptions.TypeName).toBe("self");
		expect(launchedOptions.Role).toBe("Autonomous Builder");
		expect(launchedOptions.Prompt).toBe("Build the module");
		expect(launchedOptions.Model).toBe("pro");
		expect(launchedOptions.parentModel).toBe("anthropic/claude-3-7-sonnet");
		expect(launchedOptions.Workspace).toBe("branch");
		expect(launchedOptions.parentId).toBe("parent-agent-99");
		expect(launchedOptions.cwd).toBe("/workspace/project");

		const details = result.details as Record<string, unknown>;
		expect(details.conversationId).toBe("sub-mock-custom-123");
		expect(details.logAbsoluteUri).toBe("file:///mock/logs/sub-mock-custom-123.jsonl");
		expect(details.workspaceUris).toEqual(["/mock/workspace"]);
	});

	it("returns immediately without blocking on subagent execution", async () => {
		let promptResolve: () => void;
		const promptPromise = new Promise<void>(resolve => {
			promptResolve = resolve;
		});

		const mockSession = createMockSubagentSession();
		mockSession.prompt = async () => {
			await promptPromise;
		};

		const runner = new SubagentRunner(AgentRegistry.global(), async () => ({
			session: mockSession as any,
		}));

		const tool = new InvokeSubagentTool(undefined, runner);

		const startTime = Date.now();
		const result = await tool.execute("call-nonblock", {
			TypeName: "research",
			Role: "Slow Worker",
			Prompt: "Take a long time to complete",
		});
		const elapsedMs = Date.now() - startTime;

		expect(elapsedMs).toBeLessThan(100);
		const details = result.details as Record<string, unknown>;
		expect(details.conversationId).toBeDefined();
		expect(details.conversationId as string).toStartWith("sub-");

		// Resolve prompt promise to clean up
		promptResolve!();
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
		expect(details.conversationId as string).toStartWith("sub-");
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
		expect(details.logAbsoluteUri).toBeDefined();
		expect(details.workspaceUris).toBeDefined();
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

	it("invoke_subagent + send_message round trip works with live session delivery", async () => {
		// Full round trip: invoke → get conversationId → send message delivers to live session
		const invokeTool = new InvokeSubagentTool();
		const sendTool = new SendMessageTool();

		const invokeResult = await invokeTool.execute("invoke-rt", {
			TypeName: "research",
			Role: "Research Agent",
			Prompt: "Explore the codebase",
		});

		const invokeDetails = invokeResult.details as Record<string, unknown>;
		const conversationId = invokeDetails.conversationId as string;
		expect(conversationId).toStartWith("sub-");

		const sendResult = await sendTool.execute("send-rt", {
			Recipient: conversationId,
			Message: "Please also check the test files",
		});

		// Message should be delivered to the live session attached by SubagentRunner
		const sendText = getText(sendResult as any);
		expect(sendText).toContain("delivered");
		const sendDetails = sendResult.details as Record<string, unknown>;
		expect(sendDetails.delivered).toBe(true);
	});
});
