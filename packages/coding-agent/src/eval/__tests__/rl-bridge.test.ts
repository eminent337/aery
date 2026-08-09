import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
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
	EVAL_RLM_BRIDGE_NAME,
	EVAL_RLM_LIST_BRIDGE_NAME,
	EVAL_RLM_MAX_DEPTH,
	runEvalRlm,
	runEvalRlmList,
} from "../rl-bridge";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";
import { disposeAllKernelSessions, executePython } from "../py/executor";

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["aery/task"],
} satisfies AgentDefinition;

const reviewerAgent = {
	name: "reviewer",
	description: "Reviewer agent",
	systemPrompt: "Review the task.",
	source: "bundled",
	model: ["aery/smol"],
} satisfies AgentDefinition;

interface SessionOptions {
	cwd?: string;
	sessionFile?: string | null;
	artifactsDir?: string | null;
	spawns?: string | null;
	depth?: number;
	activeModel?: string;
	modelString?: string;
	enableLsp?: boolean;
	settings?: Settings;
	outputManager?: AgentOutputManager;
	planMode?: boolean;
}

function makeSession(options: SessionOptions = {}): ToolSession {
	const settings =
		options.settings ??
		Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		});
	const artifactsDir = options.artifactsDir ?? null;
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		settings,
		taskDepth: options.depth ?? 0,
		enableLsp: options.enableLsp ?? true,
		agentOutputManager: options.outputManager,
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => options.spawns ?? "*",
		getActiveModelString: () => options.activeModel ?? "p/active",
		getModelString: () => options.modelString ?? "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
		getPlanModeState: options.planMode
			? () =>
					({
						enabled: true,
						planFilePath: path.join(options.cwd ?? process.cwd(), "plan.md"),
					}) satisfies PlanModeState
			: undefined,
	};
}

function mockAgents(agents: AgentDefinition[] = [taskAgent, reviewerAgent]): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function singleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		...overrides,
	};
}

function makeEvalSession(
	tempDir: TempDir,
	prefix: string,
	settings?: Settings,
): { session: ToolSession; sessionFile: string; sessionId: string } {
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	const session = makeSession({
		cwd: tempDir.path(),
		sessionFile,
		artifactsDir,
		settings,
		outputManager: new AgentOutputManager(() => artifactsDir),
	});
	return { session, sessionFile, sessionId: `${prefix}:${crypto.randomUUID()}` };
}

describe("runEvalRlm", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a handle immediately without waiting for completion", async () => {
		mockAgents();
		let spawnCompleted = false;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(50);
			spawnCompleted = true;
			return singleResult(options);
		});

		const session = makeSession();
		const handle = await runEvalRlm({ prompt: "hello" }, { session });

		// Handle should be returned immediately
		expect(handle).toBeDefined();
		expect(handle.id).toBeDefined();
		expect(handle.name).toBeDefined();
		expect(handle.sessionId).toBe("test-session");
		// Subagent should still be running
		expect(spawnCompleted).toBe(false);
	});

	it("resolves the default task agent and agentType overrides", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.agent.name,
			}),
		);
		const session = makeSession();

		const defaultResult = await runEvalRlm({ prompt: "hello" }, { session });
		const overrideResult = await runEvalRlm({ prompt: "hello", agentType: "reviewer" }, { session });

		expect(defaultResult.name).toBeDefined();
		expect(overrideResult.name).toBeDefined();
		expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("task");
		expect(runSpy.mock.calls[1]?.[0].agent.name).toBe("reviewer");
	});

	it("throws for an unknown agent", async () => {
		mockAgents([taskAgent]);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalRlm({ prompt: "hello", agentType: "missing" }, { session: makeSession() })).rejects.toThrow(
			'Unknown agent "missing"',
		);
	});

	it("enforces spawn restrictions and the eval recursion cap", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalRlm({ prompt: "hello" }, { session: makeSession({ spawns: "" }) })).rejects.toThrow(
			"spawns disabled",
		);
		await expect(runEvalRlm({ prompt: "hello" }, { session: makeSession({ spawns: "reviewer" }) })).rejects.toThrow(
			"Allowed: reviewer",
		);
		await expect(
			runEvalRlm({ prompt: "hello" }, { session: makeSession({ depth: EVAL_RLM_MAX_DEPTH }) }),
		).rejects.toThrow("maximum depth");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("throws instead of spawning from plan mode", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalRlm({ prompt: "hello" }, { session: makeSession({ planMode: true }) })).rejects.toThrow(
			"unavailable in plan mode",
		);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("passes parent execution context to spawned subagent", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const abortController = new AbortController();
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };
		const session = makeSession({ depth: 2, activeModel: "p/current", modelString: "p/fallback" });

		await runEvalRlm(
			{ prompt: " hello ", context: " context ", label: "My Rlm", model: "p/override", schema },
			{ session, signal: abortController.signal },
		);

		const firstOptions = runSpy.mock.calls[0]?.[0];
		if (!firstOptions) throw new Error("runSubprocess was not called");
		expect(firstOptions.taskDepth).toBe(2);
		expect(firstOptions.signal).toBe(abortController.signal);
		expect(firstOptions.parentActiveModelPattern).toBe("p/current");
		expect(firstOptions.outputSchema).toBe(schema);
		expect(firstOptions.assignment).toBe("hello");
		expect(firstOptions.context).toBe("context");
		expect(firstOptions.description).toBe("My Rlm");
		expect(firstOptions.modelOverride).toEqual(["p/override"]);
	});
});

describe("runEvalRlmList", () => {
	it("returns empty list when no subagents are tracked", () => {
		const session = makeSession();
		const result = runEvalRlmList({}, { session });
		expect(result).toEqual({ subagents: [] });
	});
});

describe("rlm() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes rlm() in JavaScript and returns handle", async () => {
		using tempDir = TempDir.createSync("@aery-eval-rlm-js-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-rlm");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		const result = await executeJs(
			'const handle = await rlm("hi"); return JSON.stringify({ id: handle.id, name: handle.name, sessionId: handle.sessionId });',
			{ cwd: tempDir.path(), sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.id).toBeDefined();
		expect(parsed.name).toBeDefined();
		expect(parsed.sessionId).toBe("test-session");
	});

	it("exposes rlm.list_subagents() in JavaScript", async () => {
		using tempDir = TempDir.createSync("@aery-eval-rlm-js-list-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-rlm-list");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		const result = await executeJs(
			'const list = await rlm.list_subagents(); return JSON.stringify(list);',
			{ cwd: tempDir.path(), sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual([]);
	});

	it("exposes rlm() in the Python runtime", async () => {
		using tempDir = TempDir.createSync("@aery-eval-rlm-py-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-rlm");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		const probe = await executePython('print("probe")', {
			cwd: tempDir.path(),
			sessionId: `${sessionId}:probe`,
			sessionFile,
			kernelMode: "per-call",
		});
		if (probe.exitCode === undefined && probe.cancelled) {
			expect(probe.output).toBe("");
			return;
		}
		expect(probe.exitCode).toBe(0);

		const result = await executePython(
			'handle = rlm("hi")\nprint(f"{handle[\"id\"]}|{handle[\"name\"]}|{handle[\"sessionId\"]}")',
			{ cwd: tempDir.path(), sessionId, sessionFile, kernelMode: "per-call", toolSession: session },
		);

		expect(result.exitCode).toBe(0);
		const parts = result.output.trim().split("|");
		expect(parts[0]).toBeDefined();
		expect(parts[1]).toBeDefined();
		expect(parts[2]).toBe("test-session");
	});

	it("exposes rlm.list_subagents() in Python", async () => {
		using tempDir = TempDir.createSync("@aery-eval-rlm-py-list-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-rlm-list");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		const result = await executePython(
			'import json\nprint(json.dumps(rlm.list_subagents()))',
			{ cwd: tempDir.path(), sessionId, sessionFile, kernelMode: "per-call", toolSession: session },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual([]);
	});
});
