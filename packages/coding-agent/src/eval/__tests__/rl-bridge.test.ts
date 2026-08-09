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

		const tempDir = TempDir.createSync("rlm-registry-");
		const { session } = makeEvalSession(tempDir, "test");

		const handle = await runEvalRlm({ prompt: "test prompt" }, { session });

		expect(handle).toBeDefined();
		expect(handle.id).toBeTruthy();
		expect(handle.name).toBeTruthy();
		expect(handle.sessionId).toBe(session.getSessionId());

		const listResult = runEvalRlmList({}, { session });
		expect(listResult.subagents).toHaveLength(1);
		expect(listResult.subagents[0].id).toBe(handle.id);
		expect(listResult.subagents[0].name).toBe(handle.name);

		disposeRlmRegistry(session.getEvalSessionId() ?? session.getSessionId() ?? "unknown");
	});

	it("removes subagent from registry on completion", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(singleResult({
			cwd: "/",
			agent: taskAgent,
			task: "test task",
			assignment: "do something",
			index: 0,
			id: "output-2",
		}));

		const tempDir = TempDir.createSync("rlm-cleanup-");
		const { session } = makeEvalSession(tempDir, "cleanup-test");

		const handle = await runEvalRlm({ prompt: "test prompt" }, { session });
		expect(handle).toBeDefined();

		disposeRlmRegistry(session.getEvalSessionId() ?? session.getSessionId() ?? "unknown");

		const listResult = runEvalRlmList({}, { session });
		expect(listResult.subagents).toHaveLength(0);
	});
});

describe("runEvalRlmList", () => {
	it("returns empty list when no subagents are tracked", () => {
		const tempDir = TempDir.createSync("rlm-list-empty-");
		const { session } = makeEvalSession(tempDir, "empty");
		const result = runEvalRlmList({}, { session });
		expect(result).toEqual({ subagents: [] });
		disposeRlmRegistry(session.getEvalSessionId() ?? session.getSessionId() ?? "unknown");
	});

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

		const tempDir = TempDir.createSync("rlm-list-active-");
		const { session } = makeEvalSession(tempDir, "list-test");

		const handle1 = await runEvalRlm({ prompt: "first" }, { session });
		const handle2 = await runEvalRlm({ prompt: "second" }, { session });

		const result = runEvalRlmList({}, { session });
		expect(result.subagents).toHaveLength(2);
		expect(result.subagents.map(h => h.id)).toContain(handle1.id);
		expect(result.subagents.map(h => h.id)).toContain(handle2.id);

		disposeRlmRegistry(session.getEvalSessionId() ?? session.getSessionId() ?? "unknown");
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

		const tempDir = TempDir.createSync("rlm-js-handle-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-handle");

		const result = await executeJs(
			`const handle = await rlm("test task", { agentType: "task" }); JSON.stringify(handle);`,
			{ cwd: tempDir.path(), sessionId, session, sessionFile },
		);

		const handle = JSON.parse(result.output.trim());
		expect(handle).toBeDefined();
		expect(typeof handle.id).toBe("string");
		expect(typeof handle.name).toBe("string");

		disposeRlmRegistry(sessionId);
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

		const tempDir = TempDir.createSync("rlm-js-list-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-list");

		const result = await executeJs(
			`const handle = await rlm("investigate bug"); const list = await rlm.list_subagents(); JSON.stringify({ handleId: handle.id, listLength: list.length });`,
			{ cwd: tempDir.path(), sessionId, session, sessionFile },
		);

		const data = JSON.parse(result.output.trim());
		expect(data.handleId).toBeTypeOf("string");
		expect(data.listLength).toBeGreaterThanOrEqual(1);

		disposeRlmRegistry(sessionId);
	});
});
