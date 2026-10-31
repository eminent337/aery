/**
 * Unit & Integration tests for ManageSubagentsTool.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ManageSubagentsTool } from "../../src/tools/manage-subagents";

describe("ManageSubagentsTool", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("has the correct name and approval level", () => {
		const tool = new ManageSubagentsTool();
		expect(tool.name).toBe("manage_subagents");
		expect(tool.approval).toBe("read");
	});

	it("list: displays message when no subagents are registered", async () => {
		const tool = new ManageSubagentsTool();
		const result = await tool.execute("call-1", { Action: "list" });
		const text = (result.content[0] as any).text;
		expect(text).toContain("No subagents currently registered");
	});

	it("list: displays active tool and arguments in table for running subagents", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-scanner-42",
			displayName: "Code Scanner [research]",
			kind: "sub",
			status: "running",
			session: null,
		});

		registry.setProgress("sub-scanner-42", {
			currentTool: "grep_search",
			currentToolArgs: "findInFiles: 'tokenSecret'",
		});

		const tool = new ManageSubagentsTool();
		const result = await tool.execute("call-2", { Action: "list" });
		const text = (result.content[0] as any).text;

		expect(text).toContain("sub-scanner-42");
		expect(text).toContain("Active Tool");
		expect(text).toContain("grep_search");
		expect(text).toContain("tokenSecret");
	});

	it("kill: aborts and disposes live session, sets status to 'aborted', and clears progress", async () => {
		const abortMock = mock(async () => {});
		const disposeMock = mock(async () => {});

		const mockSession: any = {
			abort: abortMock,
			dispose: disposeMock,
		};

		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-worker-kill-1",
			displayName: "Worker 1",
			kind: "sub",
			status: "running",
			session: mockSession,
		});

		registry.setProgress("sub-worker-kill-1", {
			currentTool: "write_file",
			currentToolArgs: "output.log",
		});

		const tool = new ManageSubagentsTool();
		const result = await tool.execute("call-3", {
			Action: "kill",
			ConversationIds: ["sub-worker-kill-1"],
		});

		expect(abortMock).toHaveBeenCalledTimes(1);
		expect(disposeMock).toHaveBeenCalledTimes(1);

		const ref = registry.get("sub-worker-kill-1");
		expect(ref?.status).toBe("aborted");
		expect(ref?.session).toBeNull();
		expect(ref?.currentTool).toBeUndefined();

		const text = (result.content[0] as any).text;
		expect(text).toContain("Killed subagents: sub-worker-kill-1");
	});

	it("kill_all: aborts and disposes all active subagents and transitions to 'aborted'", async () => {
		const abortMock1 = mock(async () => {});
		const disposeMock1 = mock(async () => {});
		const abortMock2 = mock(async () => {});
		const disposeMock2 = mock(async () => {});

		const registry = AgentRegistry.global();
		registry.register({
			id: "sub-batch-1",
			displayName: "Batch Worker 1",
			kind: "sub",
			status: "running",
			session: { abort: abortMock1, dispose: disposeMock1 } as any,
		});
		registry.register({
			id: "sub-batch-2",
			displayName: "Batch Worker 2",
			kind: "sub",
			status: "running",
			session: { abort: abortMock2, dispose: disposeMock2 } as any,
		});

		const tool = new ManageSubagentsTool();
		const result = await tool.execute("call-4", { Action: "kill_all" });

		expect(abortMock1).toHaveBeenCalledTimes(1);
		expect(disposeMock1).toHaveBeenCalledTimes(1);
		expect(abortMock2).toHaveBeenCalledTimes(1);
		expect(disposeMock2).toHaveBeenCalledTimes(1);

		expect(registry.get("sub-batch-1")?.status).toBe("aborted");
		expect(registry.get("sub-batch-2")?.status).toBe("aborted");

		const text = (result.content[0] as any).text;
		expect(text).toContain("Terminated all 2 active subagents");
	});

	it("kill: reports unknown ids in notFound", async () => {
		const tool = new ManageSubagentsTool();
		const result = await tool.execute("call-5", {
			Action: "kill",
			ConversationIds: ["sub-unknown-999"],
		});

		const text = (result.content[0] as any).text;
		expect(text).toContain("Not found or already inactive: sub-unknown-999");
	});
});
