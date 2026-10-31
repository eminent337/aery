/**
 * Subagent Reactive Wakeup Integration Tests — Ported from Google Antigravity (agy).
 *
 * Verifies that when a subagent completes background execution or encounters an error,
 * the parent session is reactively woken up via high-priority SYSTEM_MESSAGE delivery.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { createMockSubagentSession, SubagentRunner } from "../../src/registry/subagent-runner";

describe("SubagentRunner - Reactive Wakeup Engine", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("reactively wakes parent with completion message when subagent prompt completes", async () => {
		const parentSendCustomMock = mock(async () => {});
		const mockParentSession: any = {
			sendCustomMessage: parentSendCustomMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "parent-session-123",
			displayName: "Main Orchestrator",
			kind: "main",
			session: mockParentSession,
			status: "idle",
		});

		let resolvePrompt!: () => void;
		const promptPromise = new Promise<void>(resolve => {
			resolvePrompt = resolve;
		});

		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {
			await promptPromise;
		});
		(mockChildSession as any).getLastAssistantText = () => "Analysis finished: 2 vulnerabilities identified.";

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Security Auditor",
			Prompt: "Audit packages/auth for vulnerabilities",
			parentId: "parent-session-123",
		});

		const childRef = registry.get(launchResult.conversationId);
		expect(childRef?.status).toBe("running");

		// Parent should not have been woken yet while subagent is still working
		expect(parentSendCustomMock).not.toHaveBeenCalled();

		// Complete the subagent turn
		resolvePrompt();
		// Wait microtasks for background handler to execute
		await new Promise(r => setTimeout(r, 50));

		// Parent should have received reactive wakeup
		expect(parentSendCustomMock).toHaveBeenCalledTimes(1);
		const callArgs = parentSendCustomMock.mock.calls[0] as any[];
		const sentMessage = callArgs[0];
		const deliveryOpts = callArgs[1];

		expect(sentMessage.customType).toBe("agent_message");
		expect(sentMessage.display).toBe(true);
		expect(sentMessage.attribution).toBe("agent");
		expect(sentMessage.details?.from).toBe(launchResult.conversationId);
		expect(sentMessage.details?.status).toBe("completed");
		expect(sentMessage.details?.priority).toBe("MESSAGE_PRIORITY_HIGH");

		// Content must match AGY reactive wakeup format
		expect(sentMessage.content).toContain("<SYSTEM_MESSAGE>");
		expect(sentMessage.content).toContain(`sender=${launchResult.conversationId}`);
		expect(sentMessage.content).toContain("priority=MESSAGE_PRIORITY_HIGH");
		expect(sentMessage.content).toContain("Subagent completed execution:");
		expect(sentMessage.content).toContain("Analysis finished: 2 vulnerabilities identified.");
		expect(sentMessage.content).toContain("</SYSTEM_MESSAGE>");

		// Delivery options must trigger reactive turn
		expect(deliveryOpts?.triggerTurn).toBe(true);
		expect(deliveryOpts?.deliverAs).toBe("followUp");

		// Subagent status in registry should be transitioned to idle
		expect(childRef?.status).toBe("idle");
	});

	it("does not duplicate completion message if subagent already sent parent message", async () => {
		const parentSendCustomMock = mock(async () => {});
		const mockParentSession: any = {
			sendCustomMessage: parentSendCustomMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main Agent",
			kind: "main",
			session: mockParentSession,
			status: "idle",
		});

		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {
			// Subagent marks that it communicated with parent
			(mockChildSession as any).__sentParentMessage = true;
		});
		(mockChildSession as any).getLastAssistantText = () => "Manual report sent";

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Communicative Agent",
			Prompt: "Inspect and report back directly",
			parentId: MAIN_AGENT_ID,
		});

		// Wait microtasks for background handler
		await new Promise(r => setTimeout(r, 50));

		// Parent should NOT receive a duplicate completion message
		expect(parentSendCustomMock).not.toHaveBeenCalled();

		// But subagent status must still be set to idle
		const childRef = registry.get(launchResult.conversationId);
		expect(childRef?.status).toBe("idle");
	});

	it("reactively wakes parent with error notice when subagent prompt throws", async () => {
		const parentSendCustomMock = mock(async () => {});
		const mockParentSession: any = {
			sendCustomMessage: parentSendCustomMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "parent-err-session",
			displayName: "Parent Coordinator",
			kind: "main",
			session: mockParentSession,
			status: "idle",
		});

		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {
			throw new Error("Context window exceeded maximum limit");
		});

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Failing Worker",
			Prompt: "Try impossible task",
			parentId: "parent-err-session",
		});

		await new Promise(r => setTimeout(r, 50));

		// Parent should have received error notification
		expect(parentSendCustomMock).toHaveBeenCalledTimes(1);
		const callArgs = parentSendCustomMock.mock.calls[0] as any[];
		const sentMessage = callArgs[0];
		const deliveryOpts = callArgs[1];

		expect(sentMessage.customType).toBe("agent_message");
		expect(sentMessage.details?.status).toBe("error");
		expect(sentMessage.content).toContain("<SYSTEM_MESSAGE>");
		expect(sentMessage.content).toContain("Subagent terminated with error: Context window exceeded maximum limit");
		expect(sentMessage.content).toContain("</SYSTEM_MESSAGE>");
		expect(deliveryOpts?.triggerTurn).toBe(true);

		const childRef = registry.get(launchResult.conversationId);
		expect(childRef?.status).toBe("idle");
	});

	it("defaults to MAIN_AGENT_ID when parentId is omitted and wakes main session", async () => {
		const mainSendCustomMock = mock(async () => {});
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main Agent",
			kind: "main",
			session: { sendCustomMessage: mainSendCustomMock } as any,
			status: "idle",
		});

		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {});
		(mockChildSession as any).getLastAssistantText = () => "Default parent output";

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Autonomous Explorer",
			Prompt: "Explore without explicit parentId",
		});

		expect(launchResult.conversationId).toStartWith("sub-");

		await new Promise(r => setTimeout(r, 50));

		expect(mainSendCustomMock).toHaveBeenCalledTimes(1);
		const callArgs = mainSendCustomMock.mock.calls[0] as any[];
		expect(callArgs[0].content).toContain("Subagent completed execution:\n\nDefault parent output");
		expect(callArgs[1]?.triggerTurn).toBe(true);
	});

	it("executes reactive wakeup in launchMock when Prompt is provided", async () => {
		const parentSendCustomMock = mock(async () => {});
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main Agent",
			kind: "main",
			session: { sendCustomMessage: parentSendCustomMock } as any,
			status: "idle",
		});

		const runner = new SubagentRunner(registry);
		const launchResult = await runner.launchMock({
			TypeName: "research",
			Role: "Mock Worker",
			Prompt: "Perform mock task",
			parentId: MAIN_AGENT_ID,
		});

		await new Promise(r => setTimeout(r, 50));

		expect(parentSendCustomMock).toHaveBeenCalledTimes(1);
		const callArgs = parentSendCustomMock.mock.calls[0] as any[];
		expect(callArgs[0].content).toContain("<SYSTEM_MESSAGE>");
		expect(callArgs[0].content).toContain(`sender=${launchResult.conversationId}`);
		expect(callArgs[1]?.triggerTurn).toBe(true);

		const ref = registry.get(launchResult.conversationId);
		expect(ref?.status).toBe("idle");
	});

	it("handles delivery failure gracefully if parent session throws during completion wakeup", async () => {
		const throwingParentSession: any = {
			sendCustomMessage: mock(async () => {
				throw new Error("Parent transport severed");
			}),
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "parent-throwing",
			displayName: "Throwing Parent",
			kind: "main",
			session: throwingParentSession,
			status: "idle",
		});

		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {});

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Resilient Subagent",
			Prompt: "Finish despite parent crash",
			parentId: "parent-throwing",
		});

		// Wait for background execution to complete and ensure no uncaught rejection
		await new Promise(r => setTimeout(r, 50));

		const childRef = registry.get(launchResult.conversationId);
		expect(childRef?.status).toBe("idle");
	});

	it("initializes status to idle and clears tool progress when prompt is omitted", async () => {
		const registry = AgentRegistry.global();
		const runner = new SubagentRunner(registry);

		const launchResult = await runner.launchMock({
			TypeName: "research",
			Role: "Idle Helper",
		});

		const ref = registry.get(launchResult.conversationId);
		expect(ref?.status).toBe("idle");

		// Test setProgress clearing with undefined
		registry.setProgress(launchResult.conversationId, {
			currentTool: "read_file",
			currentToolArgs: "package.json",
		});
		expect(ref?.currentTool).toBe("read_file");

		registry.setProgress(launchResult.conversationId, {
			currentTool: undefined,
			currentToolArgs: undefined,
		});
		expect(ref?.currentTool).toBeUndefined();
		expect(ref?.currentToolArgs).toBeUndefined();
	});

	it("preserves 'aborted' status if agent was killed during execution", async () => {
		const registry = AgentRegistry.global();
		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {
			// Abort occurs mid-turn
			registry.setStatus("sub-aborted-test", "aborted");
			throw new Error("Session aborted");
		});

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Aborted Worker",
			Prompt: "Run doomed task",
		});

		// Force the id to match test hook
		registry.setStatus(launchResult.conversationId, "aborted");

		await new Promise(r => setTimeout(r, 50));

		const ref = registry.get(launchResult.conversationId);
		expect(ref?.status).toBe("aborted");
	});

	it("resets __sentParentMessage at start of new execution allowing follow-up turn wakeup", async () => {
		const parentSendCustomMock = mock(async () => {});
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main Agent",
			kind: "main",
			session: { sendCustomMessage: parentSendCustomMock } as any,
			status: "idle",
		});

		const mockChildSession = createMockSubagentSession();
		// Simulate subagent having sent a parent message in an earlier turn
		(mockChildSession as any).__sentParentMessage = true;
		(mockChildSession as any).getLastAssistantText = () => "Follow-up turn complete";

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Follow-up Worker",
			Prompt: "Turn 2 prompt",
		});

		expect(launchResult.conversationId).toStartWith("sub-");

		await new Promise(r => setTimeout(r, 50));

		// Flag was reset, so completion message for turn 2 is sent!
		expect(parentSendCustomMock).toHaveBeenCalledTimes(1);
		const callArgs = parentSendCustomMock.mock.calls[0] as any[];
		expect(callArgs[0].content).toContain("Follow-up turn complete");
	});

	it("suppresses error notice to parent when subagent execution is intentionally aborted", async () => {
		const parentSendCustomMock = mock(async () => {});
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main Agent",
			kind: "main",
			session: { sendCustomMessage: parentSendCustomMock } as any,
			status: "idle",
		});

		const mockChildSession = createMockSubagentSession();
		mockChildSession.prompt = mock(async () => {
			const err = new Error("Session was aborted");
			err.name = "AbortError";
			throw err;
		});

		const runner = new SubagentRunner(registry, async () => ({
			session: mockChildSession as any,
		}));

		const launchResult = await runner.launch({
			TypeName: "research",
			Role: "Aborting Subagent",
			Prompt: "Task interrupted",
		});

		// Abort status set
		registry.setStatus(launchResult.conversationId, "aborted");

		await new Promise(r => setTimeout(r, 50));

		// Parent should NOT be woken up with a crash error
		expect(parentSendCustomMock).not.toHaveBeenCalled();
	});
});
