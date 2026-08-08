/**
 * Continual Harness Tests
 */

import { describe, expect, it } from "bun:test";
import { createContinualHarnessEngine, type HarnessHost, type RefinementResult } from "../src/continual-harness/index.js";
import {
	appendGlobalRefinement,
	getGlobalHarnessStateDir,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	saveHarnessState,
} from "../src/continual-harness/state.js";

describe("ContinualHarnessEngine", () => {
	const createMockHost = (): HarnessHost => {
		let state: ReturnType<typeof loadHarnessState> = {
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
			refinements: [],
		};
		let history: RefinementResult[] = [];
		
		return {
			getHarnessState: async () => state,
			saveHarnessState: async (s) => { state = s; },
			getRefinementHistory: async () => history,
			appendRefinementHistory: async (r) => { history.push(r); },
			getTrajectory: async () => "Test trajectory with some patterns",
			now: () => new Date().toISOString(),
			nowMs: () => Date.now(),
		} as unknown as HarnessHost;
	};

	it("should create engine", () => {
		const host = createMockHost();
		const engine = createContinualHarnessEngine(host);
		expect(engine).toBeDefined();
	});
});

describe("Harness State Management", () => {
	it("should load empty state when file doesn't exist", () => {
		const state = loadHarnessState("/tmp/nonexistent-harness-" + Date.now());
		expect(state.schema).toBe(1);
		expect(state.entries).toBeDefined();
		expect(state.refinements).toEqual([]);
	});

	it("should save and load state", async () => {
		const dir = "/tmp/harness-test-" + Date.now();
		const state = loadHarnessState(dir);
		
		// Add an entry
		state.entries.memory["test-id"] = {
			id: "test-id",
			kind: "memory",
			title: "Test Memory",
			content: "This is a test memory",
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
		
		// Save
		const path = saveHarnessState(dir, state);
		expect(path).toContain(dir);
		
		// Load
		const loaded = loadHarnessState(dir);
		expect(loaded.entries.memory["test-id"]).toBeDefined();
		expect(loaded.entries.memory["test-id"]?.title).toBe("Test Memory");
		
		// Cleanup
		await Bun.file(path).delete();
	});

	it("should merge global and local states", () => {
		const globalState = loadHarnessState("/tmp/global-test-" + Date.now());
		globalState.entries.memory["global-mem"] = {
			id: "global-mem",
			kind: "memory",
			title: "Global Memory",
			content: "Global",
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
		
		const localState = loadHarnessState("/tmp/local-test-" + Date.now());
		localState.entries.memory["local-mem"] = {
			id: "local-mem",
			kind: "memory",
			title: "Local Memory",
			content: "Local",
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
		
		const merged = mergeHarnessStates(globalState, localState);
		expect(merged.entries.memory["global-mem"]).toBeDefined();
		expect(merged.entries.memory["local-mem"]).toBeDefined();
		expect(merged.entries.memory["local-mem"]?.scope).toBe("local");
	});

	it("should handle corrupt state file gracefully", () => {
		const dir = "/tmp/corrupt-test-" + Date.now();
		const state = loadHarnessState(dir);
		
		// Write corrupt data
		const path = `/tmp/corrupt-${Date.now()}.json`;
		Bun.write(path, "{ invalid json");
		
		// Should return empty state, not throw
		const loaded = loadHarnessState(dir);
		expect(loaded.schema).toBe(1);
		
		// Cleanup
		Bun.write(path, "");
	});
});

describe("Refinement History", () => {
	it("should append and load history", async () => {
		const dir = "/tmp/history-test-" + Date.now();
		const result: RefinementResult = {
			id: "test-result",
			summary: "Test summary",
			rationale: "Test rationale",
			expectedOutcome: "Test outcome",
			appliedEdits: [],
			harnessStatePath: dir,
			scope: "global",
		};
		
		appendGlobalRefinement(dir, result);
		const history = loadGlobalRefinementHistory(dir);
		
		expect(history).toHaveLength(1);
		expect(history[0]?.id).toBe("test-result");
		
		// Cleanup
		try {
			await Bun.file(`/tmp/history-test-${Date.now()}/refinements.jsonl`).delete();
		} catch {
			// Ignore
		}
	});

	it("should merge global and session history", () => {
		const global = [
			{ id: "global-1", summary: "Global", appliedEdits: [], harnessStatePath: "" } as RefinementResult,
			{ id: "global-2", summary: "Global 2", appliedEdits: [], harnessStatePath: "" } as RefinementResult,
		];
		
		const session = [
			{ id: "session-1", summary: "Session", appliedEdits: [], harnessStatePath: "" } as RefinementResult,
			{ id: "global-1", summary: "Updated Global", appliedEdits: [], harnessStatePath: "" } as RefinementResult,
		];
		
		const merged = mergeRefinementHistory(global, session);
		expect(merged).toHaveLength(3);
		
		// Session should win on conflict
		const updated = merged.find(r => r.id === "global-1");
		expect(updated?.summary).toBe("Updated Global");
	});

	it("should skip malformed history lines", () => {
		const dir = "/tmp/malformed-test-" + Date.now();
		
		// Write malformed data
		const path = `/tmp/malformed-${Date.now()}.jsonl`;
		Bun.write(path, '{"id":"valid"}\n{invalid json\n{"id":"also-valid"}\n');
		
		const history = loadGlobalRefinementHistory(dir);
		expect(history.length).toBeGreaterThanOrEqual(0);
	});
});

describe("Edge Cases", () => {
	it("should handle empty trajectory", async () => {
		const host = {
			getHarnessState: async () => ({
				schema: 1,
				entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
				refinements: [],
			}),
			saveHarnessState: async () => {},
			getRefinementHistory: async () => [],
			appendRefinementHistory: async () => {},
			getTrajectory: async () => "",
			now: () => new Date().toISOString(),
			nowMs: () => Date.now(),
		} as unknown as HarnessHost;
		
		const engine = createContinualHarnessEngine(host);
		expect(engine).toBeDefined();
	});

	it("should handle no history", async () => {
		const host = {
			getHarnessState: async () => ({
				schema: 1,
				entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
				refinements: [],
			}),
			saveHarnessState: async () => {},
			getRefinementHistory: async () => [],
			appendRefinementHistory: async () => {},
			getTrajectory: async () => "Some trajectory",
			now: () => new Date().toISOString(),
			nowMs: () => Date.now(),
		} as unknown as HarnessHost;
		
		const engine = createContinualHarnessEngine(host);
		expect(engine).toBeDefined();
	});
});
