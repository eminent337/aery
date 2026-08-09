import { describe, expect, it, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSessionHarnessHost,
	loadHarnessState,
	mergeHarnessStates,
	splitHarnessStateByScope,
} from "../src/continual-harness/state.js";
import { createCronScheduler, getGlobalCronScheduler, type CronScheduler } from "../src/cron/scheduler.js";
import type { CronSchedulerHost } from "../src/cron/types.js";
import { ContinualHarnessEngine, createContinualHarnessEngine } from "../src/continual-harness/engine.js";

describe("Continual Harness Integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-int-test-"));
	});

	it("should initialize session harness host and merge global and local states", async () => {
		const mockSessionManager: any = {
			sessionFile: path.join(tmpDir, "sessions", "test-session.jsonl"),
			getBranch: () => [
				{ message: { role: "user", content: "Implement feature X" } },
				{ message: { role: "assistant", content: "I will write the code." } },
			],
		};

		const host = createSessionHarnessHost(mockSessionManager, tmpDir);
		const state = await host.getHarnessState();

		expect(state).toBeDefined();
		expect(state.schema).toBe(1);
		expect(state.entries).toBeDefined();
		expect(state.entries.prompt).toEqual({});

		const trajectory = await host.getTrajectory();
		expect(trajectory).toContain("USER: Implement feature X");
		expect(trajectory).toContain("ASSISTANT: I will write the code.");
	});

	it("should manipulate harness state entries cleanly", async () => {
		const mockSessionManager: any = {
			sessionFile: path.join(tmpDir, "sessions", "test-session.jsonl"),
			getBranch: () => [],
		};

		const host = createSessionHarnessHost(mockSessionManager, tmpDir);
		const engine = createContinualHarnessEngine(host);

		const initialStatus = await host.getHarnessState();
		expect(initialStatus.entries.memory).toEqual({});

		const history = await host.getRefinementHistory();
		expect(Array.isArray(history)).toBe(true);
	});

	it("should manage cron jobs via global cron scheduler", async () => {
		const scheduler = getGlobalCronScheduler();
		expect(scheduler).toBeDefined();
		expect(scheduler.isRunning).toBe(true);

		const created = await scheduler.store.create({
			schedule: "every 5m",
			sessionId: "test-sess-123",
			deliveryMode: "follow_up",
			enabled: true,
		});

		expect(created.id).toBeDefined();
		expect(created.schedule).toBe("every 5m");

		const fetched = await scheduler.store.get(created.id);
		expect(fetched).toBeDefined();
		expect(fetched?.sessionId).toBe("test-sess-123");

		const deleted = await scheduler.store.delete(created.id);
		expect(deleted).toBe(true);
	});
	it("should split a merged harness state back into global and local halves", async () => {
		const state = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					"mem-1": {
						id: "mem-1",
						kind: "memory",
						title: "Global fact",
						content: "g",
						path: "",
						scope: "global",
						reference: {},
						arguments: {},
						metadata: {},
						source: "test",
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						version: 1,
					},
					"local:mem-2": {
						id: "mem-2",
						kind: "memory",
						title: "Local fact",
						content: "l",
						path: "",
						scope: "local",
						reference: {},
						arguments: {},
						metadata: {},
						source: "test",
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						version: 1,
					},
				},
				skill: {},
				subagent: {},
			},
			refinements: [],
		};
		const { global, local } = splitHarnessStateByScope(state as any);
		expect(Object.keys(global.entries.memory)).toEqual(["mem-1"]);
		expect(Object.keys(local.entries.memory)).toEqual(["mem-2"]);
		expect(local.entries.memory["mem-2"].scope).toBe("local");
	});
	it("should not duplicate refinement history across a merge/split cycle", async () => {
		const entry = {
			id: "ref-1",
			trigger: "compact",
			changes: ["c1"],
			evidence: "e",
			outcome: "o",
			created_at: new Date().toISOString(),
		};
		const state: any = {
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
			refinements: [
				{ ...entry, scope: "global" },
				{ ...entry, scope: "local" },
			],
		};
		// First split: each half keeps its own event.
		const split1 = splitHarnessStateByScope(state);
		expect(split1.global.refinements).toHaveLength(1);
		expect(split1.local.refinements).toHaveLength(1);
		// Simulate a flush cycle: save the split halves, reload and merge.
		const merged = mergeHarnessStates(split1.global, split1.local);
		expect(merged.refinements).toHaveLength(2);
		// Second split must not grow the history.
		const split2 = splitHarnessStateByScope(merged);
		expect(split2.global.refinements).toHaveLength(1);
		expect(split2.local.refinements).toHaveLength(1);
	});
	it("should persist global and local harness state to separate files", async () => {
		const mockSessionManager: any = {
			sessionFile: path.join(tmpDir, "sessions", "test-session.jsonl"),
			getBranch: () => [],
		};
		const host = createSessionHarnessHost(mockSessionManager, tmpDir);
		const state = await host.getHarnessState();
		state.entries.memory["global-mem"] = {
			id: "global-mem",
			kind: "memory",
			title: "Global memory",
			content: "g",
			path: "",
			scope: "global",
			reference: {},
			arguments: {},
			metadata: {},
			source: "test",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			version: 1,
		};
		state.entries.memory["local-mem"] = {
			id: "local-mem",
			kind: "memory",
			title: "Local memory",
			content: "l",
			path: "",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "test",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			version: 1,
		};
		await host.saveHarnessState(state);
		// Global file should contain only the global entry; local only the local.
		const globalDir = path.join(tmpDir, "harness");
		const localDir = path.join(tmpDir, "sessions", "harness");
		const globalState = loadHarnessState(globalDir, "global");
		const localState = loadHarnessState(localDir, "local");
		expect(Object.keys(globalState.entries.memory)).toContain("global-mem");
		expect(Object.keys(globalState.entries.memory)).not.toContain("local-mem");
		expect(Object.keys(localState.entries.memory)).toContain("local-mem");
		expect(Object.keys(localState.entries.memory)).not.toContain("global-mem");
	});
	it("should deliver cron jobs to the resolved live session", async () => {
		const delivered: string[] = [];
		const store = {
			list: async () => [],
			get: async () => undefined,
			create: async () => {
				throw new Error("not used");
			},
			update: async () => undefined,
			delete: async () => true,
			findDue: async () => [],
		};
		const host: CronSchedulerHost = {
			store: store as any,
			now: () => Date.now(),
			emit: () => {},
			executeSession: async (sessionId, deliveryMode) => {
				delivered.push(`${sessionId}:${deliveryMode}`);
			},
		};
		const scheduler: CronScheduler = createCronScheduler(host, { checkIntervalMs: 1 });
		scheduler.start();
		// Use executeDue directly to avoid waiting on the interval.
		// Instead simulate by calling the scheduler's public path with a due job.
		const fakeJob = {
			id: "job-1",
			schedule: "every 5m",
			sessionId: "sess-1",
			deliveryMode: "follow_up" as const,
			enabled: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			nextRunAt: Date.now() - 1,
		};
		(store.findDue as any) = async () => [fakeJob];
		await (scheduler as any).executeDue();
		expect(delivered).toContain("sess-1:follow_up");
		scheduler.stop();
	});
});
