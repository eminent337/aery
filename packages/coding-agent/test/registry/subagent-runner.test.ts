import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { defineCustomSubagent, resetCustomSubagentsForTests } from "../../src/registry/builtin-subagents";
import {
	createMockSubagentSession,
	generateConversationId,
	resolveSubagentModel,
	resolveSubagentTools,
	type SubagentLaunchOptions,
	type SubagentLaunchResult,
	SubagentRunner,
} from "../../src/registry/subagent-runner";

describe("SubagentRunner Engine", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetCustomSubagentsForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetCustomSubagentsForTests();
	});

	describe("generateConversationId", () => {
		it("starts with 'sub-' and includes role slug", () => {
			const id = generateConversationId("Codebase Researcher");
			expect(id).toStartWith("sub-");
			expect(id).toContain("codebase-researcher");
		});

		it("handles roles with special characters and punctuation", () => {
			const id = generateConversationId("Database & API Auditor!");
			expect(id).toStartWith("sub-");
			expect(id).toContain("database-api-auditor");
		});

		it("handles empty or whitespace role with fallback slug", () => {
			const id = generateConversationId("   ");
			expect(id).toStartWith("sub-");
			expect(id).toContain("agent");
		});

		it("generates unique IDs across calls", () => {
			const id1 = generateConversationId("Code Reviewer");
			const id2 = generateConversationId("Code Reviewer");
			expect(id1).not.toBe(id2);
		});
	});

	describe("resolveSubagentTools", () => {
		it("resolves tools for 'research' including read-only tools and send_message", () => {
			const tools = resolveSubagentTools("research");
			expect(tools).toContain("read_file");
			expect(tools).toContain("search_web");
			expect(tools).toContain("find_by_name");
			expect(tools).toContain("grep_search");
			expect(tools).toContain("list_dir");
			expect(tools).toContain("send_message");
		});

		it("resolves tools for 'image-generator' including image tools and send_message", () => {
			const tools = resolveSubagentTools("image-generator");
			expect(tools).toContain("image_gen");
			expect(tools).toContain("inspect_image");
			expect(tools).toContain("send_message");
			expect(tools).toContain("write_file");
			expect(tools).toContain("read_file");
		});

		it("resolves tools for 'self' including wildcard '*' and send_message", () => {
			const tools = resolveSubagentTools("self");
			expect(tools).toContain("*");
			expect(tools).toContain("send_message");
		});

		it("resolves tools for custom subagent types and includes send_message", () => {
			defineCustomSubagent({
				name: "custom-reviewer",
				description: "Custom Code Reviewer",
				systemPrompt: "You review pull requests.",
				enableWriteTools: true,
				enableSubagentTools: false,
				enableMCPTools: true,
			});

			const tools = resolveSubagentTools("custom-reviewer");
			expect(tools).toContain("read_file");
			expect(tools).toContain("write_file");
			expect(tools).toContain("call_mcp_tool");
			expect(tools).toContain("send_message");
		});

		it("resolves customTools array override and always ensures send_message is present", () => {
			const toolsWithoutSend = resolveSubagentTools("custom-type", ["read_file", "edit_file"]);
			expect(toolsWithoutSend).toContain("read_file");
			expect(toolsWithoutSend).toContain("edit_file");
			expect(toolsWithoutSend).toContain("send_message");

			const toolsWithSend = resolveSubagentTools("custom-type", ["read_file", "send_message"]);
			expect(toolsWithSend.filter(t => t === "send_message")).toHaveLength(1);
		});
	});

	describe("resolveSubagentModel", () => {
		it("resolves 'flash' to fast flash model", () => {
			expect(resolveSubagentModel("flash")).toBe("gemini-2.5-flash");
		});

		it("resolves 'flash_lite' to ultra-fast flash-lite model", () => {
			expect(resolveSubagentModel("flash_lite")).toBe("gemini-2.5-flash-lite");
		});

		it("resolves 'pro' to pro model tier", () => {
			expect(resolveSubagentModel("pro")).toBe("gemini-2.5-pro");
		});

		it("resolves 'inherit' to parentModel when provided", () => {
			expect(resolveSubagentModel("inherit", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
		});

		it("resolves 'inherit' to default flash model when parentModel is not provided", () => {
			expect(resolveSubagentModel("inherit")).toBe("gemini-2.5-flash");
		});

		it("resolves undefined model to parentModel or default flash model", () => {
			expect(resolveSubagentModel(undefined, "gpt-5.3-codex")).toBe("gpt-5.3-codex");
			expect(resolveSubagentModel()).toBe("gemini-2.5-flash");
		});

		it("passes through explicit model names unchanged", () => {
			expect(resolveSubagentModel("anthropic/claude-3-opus")).toBe("anthropic/claude-3-opus");
		});
	});

	describe("SubagentRunner.launchMock", () => {
		it("returns conversationId, logAbsoluteUri, and workspaceUris immediately", async () => {
			const runner = new SubagentRunner();
			const options: SubagentLaunchOptions = {
				TypeName: "research",
				Role: "Codebase Researcher",
				Prompt: "Audit the auth package",
				Model: "flash",
				Workspace: "inherit",
				parentId: "parent-agent-123",
			};

			const result: SubagentLaunchResult = await runner.launchMock(options);

			expect(result.conversationId).toBeDefined();
			expect(result.conversationId).toStartWith("sub-");
			expect(result.conversationId).toContain("codebase-researcher");
			expect(result.logAbsoluteUri).toStartWith("file://");
			expect(result.workspaceUris.length).toBeGreaterThan(0);
		});

		it("registers the subagent in AgentRegistry.global() with status 'running'", async () => {
			const registry = AgentRegistry.global();
			const runner = new SubagentRunner();

			const result = await runner.launchMock({
				typeName: "self",
				role: "Autonomous Bug Fixer",
				prompt: "Fix bug in parser",
				parentId: "main-session-id",
			});

			const ref = registry.get(result.conversationId);
			expect(ref).toBeDefined();
			expect(ref?.id).toBe(result.conversationId);
			expect(ref?.kind).toBe("sub");
			expect(ref?.status).toBe("running");
			expect(ref?.parentId).toBe("main-session-id");
			expect(ref?.displayName).toContain("Autonomous Bug Fixer");
			expect(ref?.session).toBeDefined();
		});

		it("syncs subagent turn and tool events to AgentRegistry", async () => {
			const registry = AgentRegistry.global();
			const runner = new SubagentRunner();

			const result = await runner.launchMock({
				TypeName: "research",
				Role: "API Explorer",
				Prompt: "Explore API routes",
			});

			const ref = registry.get(result.conversationId);
			expect(ref).toBeDefined();
			const session = ref?.session as any;
			expect(session).toBeDefined();

			// 1. Tool execution starts
			session.emitEvent({
				type: "tool_execution_start",
				toolName: "read_file",
				args: { Path: "/home/user/project/src/index.ts" },
			});

			expect(ref?.status).toBe("running");
			expect(ref?.currentTool).toBe("read_file");
			expect(ref?.currentToolArgs).toContain("/home/user/project/src/index.ts");

			// 2. Tool execution ends
			session.emitEvent({
				type: "tool_execution_end",
				toolName: "read_file",
			});

			expect(ref?.currentTool).toBeUndefined();
			expect(ref?.currentToolArgs).toBeUndefined();

			// 3. Subagent ends
			session.emitEvent({
				type: "agent_end",
			});

			expect(ref?.status).toBe("idle");
			expect(ref?.currentTool).toBeUndefined();
		});

		it("syncs turn_start and turn_end events to AgentRegistry", async () => {
			const registry = AgentRegistry.global();
			const runner = new SubagentRunner();

			const result = await runner.launchMock({
				TypeName: "research",
				Role: "Worker",
				Prompt: "Do work",
			});

			const ref = registry.get(result.conversationId);
			const session = ref?.session as any;

			session.emitEvent({ type: "turn_start" });
			expect(ref?.status).toBe("running");

			session.emitEvent({ type: "turn_end" });
			expect(ref?.status).toBe("idle");
		});
	});

	describe("SubagentRunner.launch", () => {
		it("provides launch method that returns SubagentLaunchResult and registers in AgentRegistry", async () => {
			const mockSession = createMockSubagentSession();
			let promptCalledWith: string | undefined;
			mockSession.prompt = async (text: string) => {
				promptCalledWith = text;
			};

			const runner = new SubagentRunner(AgentRegistry.global(), async () => ({ session: mockSession as any }));
			const result = await runner.launch({
				TypeName: "research",
				Role: "Researcher",
				Prompt: "Find files in src/",
				parentId: "parent-456",
			});

			expect(result.conversationId).toStartWith("sub-");
			expect(result.logAbsoluteUri).toStartWith("file://");
			expect(result.workspaceUris.length).toBeGreaterThan(0);

			const ref = AgentRegistry.global().get(result.conversationId);
			expect(ref).toBeDefined();
			expect(ref?.status).toBe("running");
			expect(ref?.parentId).toBe("parent-456");
			expect(promptCalledWith).toBe("Find files in src/");
		});
	});
});
