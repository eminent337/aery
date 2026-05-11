import { describe, expect, test } from "vitest";
import { type CapabilitiesReport, formatCapabilitiesReport } from "../src/cli/capabilities.js";

describe("capabilities", () => {
	test("formats Aery built-in, runtime, and self-extension capabilities", () => {
		const report: CapabilitiesReport = {
			version: "0.1.103",
			cwd: "/repo",
			currentModel: {
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				thinkingLevel: "high",
				supportsImages: true,
				supportsThinking: true,
			},
			providers: {
				total: 12,
				configured: ["anthropic", "cloudflare-workers-ai"],
			},
			models: {
				total: 42,
				available: 8,
			},
			tools: {
				builtIn: ["read", "bash", "edit", "write", "grep", "find", "ls"],
				active: ["read", "bash", "edit", "write"],
				registered: ["read", "bash", "edit", "write", "subagent"],
			},
			commands: {
				builtIn: ["capabilities", "model", "session"],
				extension: ["add-echo-tool"],
				prompt: ["implement"],
				skill: ["skill:debugging"],
			},
			resources: {
				extensions: 3,
				extensionNames: ["aery-footer", "subagent", "web-search"],
				extensionErrors: 0,
				extensionLoadErrors: [],
				skills: 4,
				prompts: 2,
				themes: 1,
				contextFiles: 1,
			},
			session: {
				persisted: true,
				sessionId: "abc123",
				messages: 9,
				toolCalls: 3,
				contextPercent: 12.5,
			},
		};

		const output = formatCapabilitiesReport(report);

		expect(output).toContain("Aery Capabilities");
		expect(output).toContain("read, bash, edit, write, grep, find, ls");
		expect(output).toContain("active: read, bash, edit, write");
		expect(output).toContain("dynamic tool registration");
		expect(output).toContain("subagent delegation");
		expect(output).toContain("configured: anthropic, cloudflare-workers-ai");
		expect(output).toContain("current: anthropic/claude-sonnet-4-5");
		expect(output).toContain("thinking: high");
		expect(output).toContain("extensions: 3 loaded, 0 errors");
		expect(output).toContain("loaded extensions: aery-footer, subagent, web-search");
		expect(output).toContain("commands: 3 built-in, 1 extension, 1 prompt, 1 skill");
		expect(output).toContain("session: persisted abc123");
	});
});
