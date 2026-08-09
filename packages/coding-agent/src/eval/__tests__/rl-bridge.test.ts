import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@aryee337/aery-utils";
import { Settings } from "../../config/settings";
import type { PlanModeState } from "../../plan-mode/state";
import * as taskDiscovery from "../../task/discovery";
import type { ExecutorOptions } from "../../task/executor";
import * as taskExecutor from "../../task/executor";
import { AgentOutputManager } from "../../task/output-manager";
import type { AgentDefinition, AgentProgress, SingleResult } from "../../task/types";
import type { ToolSession } from "../../tools";
import {
	runEvalRlm,
	runEvalRlmList,
	disposeRlmRegistry,
} from "../rl-bridge";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";
import { disposeAllKernelSessions } from "../py/executor";

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	tools: ["read", "write", "edit", "grep", "find", "ls"],
	spawns: "*",
	model: ["aery/task"],
} satisfies AgentDefinition;

const reviewerAgent = {
	name: "reviewer",
	description: "Reviewer agent",
	systemPrompt: "Review the task.",
	source: "bundled",
	tools: ["read", "write", "edit", "grep", "find", "ls"],
	spawns: "*",
	model: ["aery/smol"],
} satisfies AgentDefinition;

interface SessionOptions {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	sessionSpawns?: string;
	planModeState?: PlanModeState;
	taskDepth?: number;
	parentEvalSessionId?: string;
	artifactsDir?: string;
	settings?: Settings;
}

function makeSession(options: SessionOptions = {}): ToolSession {
	const settings = options.settings ?? Settings.isolated({
		"async.enabled": false,
		"task.isolation.mode": "none",
		"task.enableLsp": true,
	});
	const artifactsDir = options.artifactsDir ?? null;
	return {
		cwd: options.cwd ?? "/",
		settings,
		taskDepth: options.taskDepth ?? 0,
		enableLsp: true,
		agentOutputManager: undefined,
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => options.sessionSpawns ?? "*",
		getActiveModelString: () => undefined,
		getModelString: () => "test-model",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => options.sessionId ?? "test-session",
		getEvalSessionId: () => options.parentEvalSessionId ?? null,
		getPlanModeState: () => options.planModeState,
		getCompactContext: () => undefined,
		skills: [],
		contextFiles: [],
		mcpManager: { getClient: () => undefined } as any,
		eventBus: { emit: () => {} } as any,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => undefined,
		getTelemetry: () => undefined,
		getArtifactManager: () => undefined,
	} as unknown as ToolSession;
}

function mockAgents(agents: AgentDefinition[] = [taskAgent, reviewerAgent]): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function singleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index ?? 0,
		id: options.id ?? "test-id",
		agent: options.agent?.name ?? "task",
		agentSource: options.agent?.source,
		task: options.task ?? "",
		assignment: options.assignment ?? "",
		description: options.description,
		exitCode: 0,
		output: "success",
		stderr: "",
		truncated: false,
		durationMs: 100,
		tokens: 50,
		modelOverride: undefined,
		...overrides,
	} as SingleResult;
}

function makeEvalSession(
	tempDir: TempDir,
	prefix: string,
	settings?: Settings,
): { session: ToolSession; sessionFile: string; sessionId: string } {
	const sessionFile = path.join(tempDir.path(), `${prefix}.jsonl`);
	const artifactsDir = path.join(tempDir.path(), `${prefix}-artifacts`);
	const session = makeSession({
		cwd: tempDir.path(),
		sessionFile,
		artifactsDir,
		settings,
		parentEvalSessionId: prefix,
	});
	return { session, sessionFile, sessionId: prefix };
}

describe("runEvalRlm", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeRlmRegistry("test-registry");
	});

	it("spawns a subagent and registers it in the registry", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(singleResult({
			cwd: "/",
			agent: taskAgent,
			task: "test task",
			assignment: "do something",
			index: 0,
			id: "output-1",
		}));

		const tempDir1 = TempDir.createSync("rlm-registry-");
		const { session: session1 } = makeEvalSession(tempDir1, "test");

		const handle1 = await runEvalRlm({ prompt: "test prompt" }, { session: session1 });

		expect(handle1).toBeDefined();
		expect(handle1.id).toBeTruthy();
		expect(handle1.name).toBeTruthy();
		expect(handle1.sessionId).toBe(session1.getSessionId());

		const listResult1 = runEvalRlmList({}, { session: session1 });
		expect(listResult1.subagents).toHaveLength(1);
		expect(listResult1.subagents[0].id).toBe(handle1.id);
		expect(listResult1.subagents[0].name).toBe(handle1.name);
		disposeRlmRegistry(session1.getEvalSessionId() ?? session1.getSessionId() ?? "unknown");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(singleResult({
			cwd: "/",
			agent: taskAgent,
			task: "test task",
			assignment: "do something",
			index: 0,
			id: "output-2",
		}));

		const tempDir2 = TempDir.createSync("rlm-cleanup-");
		const { session: session2 } = makeEvalSession(tempDir2, "cleanup-test");

		const handle2 = await runEvalRlm({ prompt: "test prompt" }, { session: session2 });
		disposeRlmRegistry(session2.getEvalSessionId() ?? session2.getSessionId() ?? "unknown");
		expect(listResult2.subagents).toHaveLength(0);
	});
});

describe("runEvalRlmList", () => {
	it("returns empty list when no subagents are tracked", () => {
		const tempDir3 = TempDir.createSync("rlm-list-empty-");
		const { session: session3 } = makeEvalSession(tempDir3, "empty");
		disposeRlmRegistry(session3.getEvalSessionId() ?? session3.getSessionId() ?? "unknown");
	it("returns active subagents from registry", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(singleResult({
			cwd: "/",
			agent: taskAgent,
			task: "test",
			assignment: "test",
			index: 0,
			id: "output-list",
		}));

		const tempDir4 = TempDir.createSync("rlm-list-active-");
		const { session: session4 } = makeEvalSession(tempDir4, "list-test");

		const handle3 = await runEvalRlm({ prompt: "first" }, { session: session4 });
		const handle4 = await runEvalRlm({ prompt: "second" }, { session: session4 });

		const result = runEvalRlmList({}, { session: session4 });
		expect(result.subagents).toHaveLength(2);
		expect(result.subagents.map(h => h.id)).toContain(handle3.id);
		disposeRlmRegistry(session4.getEvalSessionId() ?? session4.getSessionId() ?? "unknown");
	});
});

describe("rlm() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAllVmContexts();
		disposeAllKernelSessions();
		disposeRlmRegistry("rlm-runtime-test");
	});

	it("rlm() returns handle in JS eval", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(singleResult({
			cwd: "/",
			agent: taskAgent,
			task: "test",
			assignment: "test",
			index: 0,
			id: "js-output-1",
		}));

		const tempDir5 = TempDir.createSync("rlm-js-handle-");
		const { session: session5, sessionFile: sessionFile5, sessionId: sessionId5 } = makeEvalSession(tempDir5, "js-handle");

		const result = await executeJs(
			`const handle = await rlm("test task", { agentType: "task" }); JSON.stringify(handle);`,
			{ cwd: tempDir5.path(), sessionId: sessionId5, session: session5, sessionFile: sessionFile5 },
		);

		const handle = JSON.parse(result.output.trim());
		expect(handle).toBeDefined();
		expect(typeof handle.id).toBe("string");
		expect(typeof handle.name).toBe("string");

		disposeRlmRegistry(sessionId5);
	});

	it("rlm.list_subagents() discovers active children in JS", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(singleResult({
			cwd: "/",
			agent: taskAgent,
			task: "test",
			assignment: "test",
			index: 0,
			id: "js-list-output",
		}));

		const tempDir6 = TempDir.createSync("rlm-js-list-");
		const { session: session6, sessionFile: sessionFile6, sessionId: sessionId6 } = makeEvalSession(tempDir6, "js-list");

		const result = await executeJs(
			`const handle = await rlm("investigate bug"); const list = await rlm.list_subagents(); JSON.stringify({ handleId: handle.id, listLength: list.length });`,
			{ cwd: tempDir6.path(), sessionId: sessionId6, session: session6, sessionFile: sessionFile6 },
		);

		const data = JSON.parse(result.output.trim());
		expect(data.handleId).toBeTypeOf("string");
		expect(data.listLength).toBeGreaterThanOrEqual(1);

		disposeRlmRegistry(sessionId6);
	});
});
