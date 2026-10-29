import { describe, expect, it } from "vitest";
import {
	BUILTIN_EXTERNAL_AGENTS,
	getExternalAgentAdapter,
	listSupportedExternalAgents,
	resolveAgentInvocation,
} from "../src/extensibility/external-agents/adapters";

describe("External Agent Adapters", () => {
	it("registers all standard external agent adapters", () => {
		const supported = listSupportedExternalAgents();
		const ids = supported.map(a => a.id);
		expect(ids).toContain("agy");
		expect(ids).toContain("codex");
		expect(ids).toContain("opencode");
		expect(ids).toContain("claude");
		expect(ids).toContain("aider");
		expect(ids).toContain("pi");
		expect(ids).toContain("gh");
		expect(ids).toContain("custom");
	});

	it("retrieves specific adapter by id", () => {
		expect(getExternalAgentAdapter("agy")).toBe(BUILTIN_EXTERNAL_AGENTS.agy);
		expect(getExternalAgentAdapter("unknown")).toBeUndefined();
	});

	it("formats agy non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("agy", "refactor test function");
		expect(invocation.binary).toBe("agy");
		expect(invocation.args).toEqual(["-p", "refactor test function", "--dangerously-skip-permissions"]);
	});

	it("formats codex non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("codex", "write unit tests");
		expect(invocation.binary).toBe("codex");
		expect(invocation.args).toEqual(["exec", "write unit tests", "--dangerously-bypass-approvals-and-sandbox"]);
	});

	it("formats opencode non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("opencode", "fix build error");
		expect(invocation.binary).toBe("opencode");
		expect(invocation.args).toEqual(["run", "fix build error", "--auto"]);
	});

	it("formats claude non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("claude", "lint codebase");
		expect(invocation.binary).toBe("claude");
		expect(invocation.args).toEqual(["-p", "lint codebase", "--dangerously-skip-permissions"]);
	});

	it("formats aider non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("aider", "add readme file");
		expect(invocation.binary).toBe("aider");
		expect(invocation.args).toEqual(["--message", "add readme file", "--yes"]);
	});

	it("supports custom agent with explicit binary and extraArgs", () => {
		const invocation = resolveAgentInvocation("custom", "run inspection", {
			customBinary: "/opt/bin/my-agent",
			extraArgs: ["--flag1", "--flag2"],
		});
		expect(invocation.binary).toBe("/opt/bin/my-agent");
		expect(invocation.args).toEqual(["--flag1", "--flag2", "run inspection"]);
	});
});
