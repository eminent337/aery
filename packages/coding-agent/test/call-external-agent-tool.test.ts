import { describe, expect, it, vi } from "vitest";

// Mock the runner module so we don't call real external agents in tests
vi.mock("../src/extensibility/external-agents/runner", () => ({
	executeExternalAgent: vi.fn().mockResolvedValue({
		agent: "custom",
		binary: "/bin/echo",
		exitCode: 0,
		stdout: "hello tool test",
		stderr: "",
		durationMs: 50,
		timedOut: false,
	}),
}));

// Mock discovery so the test is deterministic
vi.mock("../src/extensibility/external-agents/discovery", () => ({
	detectExternalAgents: vi.fn().mockResolvedValue({
		installed: [
			{ id: "agy", displayName: "Google Antigravity (agy)", binaryPath: "/home/user/.local/bin/agy", installed: true, version: "1.4.10" },
			{ id: "codex", displayName: "OpenAI Codex CLI", binaryPath: "/usr/bin/codex", installed: true, version: "0.147.0" },
		],
		uninstalled: [
			{ id: "claude", displayName: "Anthropic Claude Code CLI", defaultBinary: "claude" },
		],
	}),
	findBinaryInPath: vi.fn(),
}));

import { CallExternalAgentTool } from "../src/tools/external-agent";

describe("CallExternalAgentTool", () => {
	// Minimal mock session matching ToolSession interface
	const mockSession = { cwd: process.cwd() } as any;
	const tool = new CallExternalAgentTool(mockSession);

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
