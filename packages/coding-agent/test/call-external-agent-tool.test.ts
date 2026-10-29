import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as discovery from "../src/extensibility/external-agents/discovery";
import * as runner from "../src/extensibility/external-agents/runner";
import { CallExternalAgentTool } from "../src/tools/external-agent";

describe("CallExternalAgentTool", () => {
	// Minimal mock session matching ToolSession interface
	const mockSession = { cwd: process.cwd() } as any;
	const tool = new CallExternalAgentTool(mockSession);

	let detectSpy: any;
	let executeSpy: any;

	beforeEach(() => {
		detectSpy = spyOn(discovery, "detectExternalAgents").mockResolvedValue({
			installed: [
				{
					id: "agy",
					displayName: "Google Antigravity (agy)",
					binaryPath: "/home/user/.local/bin/agy",
					installed: true,
					version: "1.4.10",
				},
				{
					id: "codex",
					displayName: "OpenAI Codex CLI",
					binaryPath: "/usr/bin/codex",
					installed: true,
					version: "0.147.0",
				},
			],
			uninstalled: [
				{ id: "claude", displayName: "Anthropic Claude Code CLI", defaultBinary: "claude" },
			],
		});

		executeSpy = spyOn(runner, "executeExternalAgent").mockResolvedValue({
			agent: "custom",
			binary: "/bin/echo",
			exitCode: 0,
			stdout: "hello tool test",
			stderr: "",
			durationMs: 50,
			timedOut: false,
		});
	});

	afterEach(() => {
		detectSpy?.mockRestore();
		executeSpy?.mockRestore();
	});

	it("has correct tool metadata", () => {
		expect(tool.name).toBe("call_external_agent");
		expect(tool.label).toBe("External Agent");
		expect(tool.approval).toBe("exec");
		expect(tool.parameters).toBeDefined();
	});

	it("lists installed agents when agent is 'list'", async () => {
		const result = await tool.execute("call-list-1", { agent: "list" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("Installed External Agents");
		expect(text).toContain("agy");
		expect(text).toContain("codex");
		expect(text).toContain("Uninstalled");
		expect(text).toContain("claude");
	});

	it("returns error when prompt is missing for non-list agent", async () => {
		const result = await tool.execute("call-2", { agent: "codex" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("prompt");
	});

	it("executes agent and formats output", async () => {
		const result = await tool.execute("call-3", {
			agent: "custom",
			prompt: "hello tool test",
			customBinary: "echo",
		});
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("External Agent Execution");
		expect(text).toContain("hello tool test");
	});
});
