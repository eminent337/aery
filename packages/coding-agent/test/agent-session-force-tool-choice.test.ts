import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@aryee337/aery/config/model-registry";
import { Settings } from "@aryee337/aery/config/settings";
import { AgentSession } from "@aryee337/aery/session/agent-session";
import { AuthStorage } from "@aryee337/aery/session/auth-storage";
import { convertToLlm } from "@aryee337/aery/session/messages";
import { SessionManager } from "@aryee337/aery/session/session-manager";
import { getBundledModel } from "@aryee337/aery-ai";
import { AssistantMessageEventStream } from "@aryee337/aery-ai/utils/event-stream";
import { Agent, type AgentTool } from "@aryee337/aery-core";
import { TempDir } from "@aryee337/aery-utils";
import * as z from "zod/v4";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;

beforeEach(async () => {
	tempDir = TempDir.createSync("@aery-agent-session-force-tool-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());

	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [bashTool, writeTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([
			[bashTool.name, bashTool],
			[writeTool.name, writeTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

it("forces specific tool, then transitions to none, then clears", () => {
	session.setForcedToolChoice("write");

	const first = session.nextToolChoice();
	const second = session.nextToolChoice();
	const third = session.nextToolChoice();

	expect(first).toEqual({ type: "tool", name: "write" });
	// After the forced call, "none" prevents the loop from making more tool calls
	expect(second).toBe("none");
	// After "none" is consumed, override clears entirely
	expect(third).toBeUndefined();
});

it("throws when forcing a non-active tool", () => {
	expect(() => session.setForcedToolChoice("read")).toThrow('Tool "read" is not currently active.');
});
