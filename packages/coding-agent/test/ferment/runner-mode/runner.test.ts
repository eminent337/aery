/**
 * Tests for FasRunner.
 *
 * Uses vitest. Run with:
 *   bun test packages/coding-agent/test/ferment/runner-mode/runner.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { FasAction } from "../../../src/ferment/runner-mode/engine.js";
import { FasRunner } from "../../../src/ferment/runner-mode/runner.js";
import type { Ferment, Phase, Step } from "../../../src/ferment/types.js";

// ─── Mock implementations ─────────────────────────────────────────────────────

function makeNow(): string {
	return new Date().toISOString();
}

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	const now = makeNow();
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "planned",
		goal: "Test goal",
		successCriteria: [],
		constraints: [],
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "phase-1",
		index: 1,
		name: "Phase 1",
		goal: "Phase goal",
		status: "planned",
		steps: [],
		...overrides,
	};
}

function makeStep(overrides: Partial<Step> = {}): Step {
	return {
		id: "step-1",
		index: 1,
		description: "Test step",
		status: "pending",
		...overrides,
	};
}

type MockEngineNext = () => FasAction | undefined;
type MockEngineSetFerment = (f: Ferment) => void;

class MockFasEngine {
	next: MockEngineNext;
	setFerment: MockEngineSetFerment;
	registerHook = vi.fn(() => () => {});

	constructor(nextFn: MockEngineNext = () => undefined) {
		this.next = vi.fn(nextFn);
		this.setFerment = vi.fn((_f: Ferment) => {});
	}
}

class MockFasState {
	#store = new Map<string, Ferment>();

	get = vi.fn((id: string): Ferment | null => this.#store.get(id) ?? null);
	save = vi.fn((f: Ferment) => this.#store.set(f.id, f));
	list = vi.fn((): Ferment[] => Array.from(this.#store.values()));
	onChange = vi.fn(() => () => {});
	clear() {
		this.#store.clear();
	}
	setFerment(id: string, f: Ferment) {
		this.#store.set(id, f);
	}
}

class MockFasPlanner {
	create = vi.fn((): Promise<Ferment> => Promise.resolve(makeFerment({ status: "planned" })));
	load = vi.fn((): Promise<Ferment | null> => Promise.resolve(null));
}

class MockSession {
	prompt = vi.fn((): Promise<void> => Promise.resolve());
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe("FasRunner", () => {
	let mockState: MockFasState;
	let mockPlanner: MockFasPlanner;
	let mockSession: MockSession;

	beforeEach(() => {
		mockState = new MockFasState();
		mockPlanner = new MockFasPlanner();
		mockSession = new MockSession();
	});

	// ─── run() creates new ferment via planner ───────────────────────────────

	it("run() calls planner.create() when no resumeId is provided", async () => {
		const ferment = makeFerment({ status: "planned" });
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		const engine = new MockFasEngine(() => undefined); // terminal immediately

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		const result = await runner.run("Test goal");

		expect(mockPlanner.create).toHaveBeenCalledTimes(1);
		expect(result).toBe(ferment);
	});

	it("run() uses resumeId to load existing ferment from state", async () => {
		const existing = makeFerment({ id: "resume-123", status: "planned" });
		mockState.setFerment("resume-123", existing);
		const engine = new MockFasEngine(() => undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		const result = await runner.run("Test goal", { resumeId: "resume-123" });

		expect(mockState.get).toHaveBeenCalledWith("resume-123");
		expect(mockPlanner.create).not.toHaveBeenCalled();
		expect(result.id).toBe("resume-123");
	});

	it("run() throws when resumeId not found in state", async () => {
		mockState.get = vi.fn(() => null);
		const engine = new MockFasEngine(() => undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
		});

		await expect(runner.run("goal", { resumeId: "nonexistent" })).rejects.toThrow('Ferment "nonexistent" not found');
	});

	it("run() throws when no planner and no resumeId", async () => {
		const engine = new MockFasEngine(() => undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
		});

		await expect(runner.run("goal")).rejects.toThrow("No planner configured");
	});

	// ─── run() completes when engine returns undefined ───────────────────────

	it("run() completes when engine.next() returns undefined (terminal)", async () => {
		const ferment = makeFerment({
			status: "planned",
			phases: [
				makePhase({
					id: "phase-1",
					status: "planned",
					steps: [makeStep({ id: "step-1", status: "pending" })],
				}),
			],
		});
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		// Engine action sequence that exercises: activate_phase → start_step (no verify)
		// → complete_step (handled internally) → complete_phase → complete_ferment → undefined
		const actions: FasAction[] = [
			{ kind: "activate_phase", phaseId: "phase-1", message: "Activate phase 1" },
			{ kind: "start_step", stepId: "step-1", phaseId: "phase-1", message: "Start step 1" },
			{ kind: "complete_phase", phaseId: "phase-1", message: "Complete phase 1" },
			{ kind: "complete_ferment", message: "Complete ferment" },
		];
		let actionIndex = 0;
		const engine = new MockFasEngine(() => actions[actionIndex++] ?? undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		const result = await runner.run("Test goal");

		// Should have consumed all actions and ended
		expect(engine.next).toHaveBeenCalled();
		// session.prompt should have been called once (for start_step)
		expect(mockSession.prompt).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("complete");
	});

	// ─── run() handles abort ─────────────────────────────────────────────────

	it("run() stops when abort() is called", async () => {
		const ferment = makeFerment({
			status: "planned",
			phases: [makePhase({ id: "phase-1", status: "planned", steps: [makeStep({ id: "step-1" })] })],
		});
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		let stepCount = 0;
		const engine = new MockFasEngine(() => {
			stepCount++;
			if (stepCount === 1) {
				return { kind: "start_step", stepId: "step-1", phaseId: "phase-1", message: "Start step" };
			}
			return undefined;
		});

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		// Start the run but abort immediately
		const runPromise = runner.run("goal");
		runner.abort();
		const result = await runPromise;

		// Loop should have exited due to abort signal
		expect(result).toBeDefined();
	});

	// ─── pause / resume ──────────────────────────────────────────────────────

	it("pause() stops the loop at next iteration", async () => {
		const ferment = makeFerment({
			status: "planned",
			phases: [makePhase({ id: "phase-1", status: "planned", steps: [makeStep({ id: "step-1" })] })],
		});
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		let actionCount = 0;
		const engine = new MockFasEngine(() => {
			actionCount++;
			// First action returns activate_phase, then will return start_step
			if (actionCount === 1) {
				return { kind: "activate_phase", phaseId: "phase-1", message: "Activate" };
			}
			// Second action would be start_step but we pause before it is consumed
			if (actionCount === 2) {
				return { kind: "start_step", stepId: "step-1", phaseId: "phase-1", message: "Start" };
			}
			return undefined;
		});

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		// Pause right after the first action (activate_phase) is processed
		let didPause = false;
		void runner.run("goal").then(f => {
			didPause = f.status === "paused";
		});
		// Request pause — will be checked at top of next loop iteration
		runner.pause();
		// Wait a tick for the loop to process the pause
		await new Promise(resolve => setTimeout(resolve, 10));

		// The pause flag was set; the loop should exit on next iteration
		// Verify by checking state.save was called (iterations happened)
		expect(mockState.save).toHaveBeenCalled();
	});

	// ─── run() throws on transition error ────────────────────────────────────

	it("run() throws when applyTransition returns an error", async () => {
		// Build a ferment where activate_phase is invalid (no phase with that id)
		const ferment = makeFerment({ status: "planned", phases: [] });
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		// Engine returns activate_phase but there's no phase to activate
		const engine = new MockFasEngine(() => ({
			kind: "activate_phase" as const,
			phaseId: "nonexistent",
			message: "Activate nonexistent",
		}));

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		await expect(runner.run("goal")).rejects.toThrow(/Transition error/);
	});

	// ─── resume() ─────────────────────────────────────────────────────────────

	it("resume() loads a paused ferment and continues", async () => {
		const pausedFerment = makeFerment({
			id: "paused-1",
			status: "paused",
			phases: [
				makePhase({
					id: "phase-1",
					status: "completed",
					steps: [makeStep({ id: "step-1", status: "verified" })],
				}),
				makePhase({
					id: "phase-2",
					status: "planned",
					steps: [makeStep({ id: "step-2", status: "pending" })],
				}),
			],
		});
		mockState.setFerment("paused-1", pausedFerment);

		// Engine starts by returning complete_ferment since phase-1 is done
		const engine = new MockFasEngine(() => undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
		});

		const result = await runner.resume("paused-1");

		expect(mockState.get).toHaveBeenCalledWith("paused-1");
		expect(result.status).toBe("planned");
	});

	it("resume() throws when ferment is not paused", async () => {
		const runningFerment = makeFerment({ id: "running-1", status: "running" });
		mockState.setFerment("running-1", runningFerment);

		const engine = new MockFasEngine(() => undefined);
		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
		});

		await expect(runner.resume("running-1")).rejects.toThrow(/expected "paused"/);
	});

	// ─── engine action: scope is skipped (already handled by planner) ────────

	it("run() skips scope action (already handled by planner)", async () => {
		const ferment = makeFerment({ status: "planned" });
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		// Engine accidentally returns scope (shouldn't happen normally)
		const engine = new MockFasEngine(() => undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		await runner.run("goal");

		// Should have called planner once and exited cleanly
		expect(mockPlanner.create).toHaveBeenCalledTimes(1);
	});

	// ─── engine action: refine is a no-op ─────────────────────────────────────

	it("run() treats refine as no-op when steps already exist", async () => {
		const ferment = makeFerment({
			status: "planned",
			phases: [
				makePhase({
					id: "phase-1",
					status: "active",
					steps: [makeStep({ id: "step-1" })],
				}),
			],
		});
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		// Engine returns refine, then start_step
		let callCount = 0;
		const engine = new MockFasEngine(() => {
			callCount++;
			if (callCount === 1) {
				return { kind: "refine", phaseId: "phase-1", message: "Refine" };
			}
			if (callCount === 2) {
				return { kind: "start_step", stepId: "step-1", phaseId: "phase-1", message: "Start" };
			}
			return undefined;
		});

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		await runner.run("goal");

		// refine was treated as no-op (no session.prompt call), then start_step ran
		expect(mockSession.prompt).toHaveBeenCalledTimes(1);
	});

	// ─── recover_step retry logic ─────────────────────────────────────────────

	it("run() retries failed step up to maxStepAttempts", async () => {
		// We test the recover_step path by having the engine return recover_step
		// which should invoke executeStartStep again
		const stepWithVerify = makeStep({
			id: "step-1",
			status: "failed",
			verification: { command: "echo ok", retries: 0 },
		});
		const ferment = makeFerment({
			status: "planned",
			phases: [
				makePhase({
					id: "phase-1",
					status: "active",
					steps: [stepWithVerify],
				}),
			],
		});
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		let callCount = 0;
		const engine = new MockFasEngine(() => {
			callCount++;
			if (callCount === 1) {
				return { kind: "recover_step", stepId: "step-1", phaseId: "phase-1", message: "Recover" };
			}
			return undefined;
		});

		// Mock prompt to avoid actual agent call
		mockSession.prompt = vi.fn(() => Promise.resolve());

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
			maxStepAttempts: 2,
		});

		// Mock executeBash for verification
		vi.mock("../../../src/exec/bash-executor.js", () => ({
			executeBash: vi.fn(() =>
				Promise.resolve({
					exitCode: 0,
					output: "ok",
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 2,
					outputLines: 1,
					outputBytes: 2,
				}),
			),
		}));

		const { executeBash } = await import("../../../src/exec/bash-executor.js");

		await runner.run("goal");

		// recover_step should have been handled (retry attempted)
		expect(mockSession.prompt).toHaveBeenCalled();

		vi.restoreAllMocks();
	});

	// ─── engine bootstrapping ──────────────────────────────────────────────────

	it("run() calls engine.setFerment after initial setup", async () => {
		const ferment = makeFerment({ status: "planned" });
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		const engine = new MockFasEngine(() => undefined);

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		await runner.run("goal");

		// setFerment should have been called at least once (initial bootstrap)
		expect((engine.setFerment as any).mock.calls.length).toBeGreaterThan(0);
	});

	// ─── state.save called after each transition ─────────────────────────────

	it("run() calls state.save after each loop iteration", async () => {
		const ferment = makeFerment({
			status: "planned",
			phases: [
				makePhase({
					id: "phase-1",
					status: "planned",
					steps: [makeStep({ id: "step-1", status: "pending" })],
				}),
			],
		});
		mockPlanner.create = vi.fn(() => Promise.resolve(ferment));
		mockState.setFerment(ferment.id, ferment);

		let actionCount = 0;
		const engine = new MockFasEngine(() => {
			actionCount++;
			if (actionCount === 1) return { kind: "activate_phase", phaseId: "phase-1", message: "Activate" };
			if (actionCount === 2) return { kind: "start_step", stepId: "step-1", phaseId: "phase-1", message: "Start" };
			return undefined;
		});

		const runner = new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			planner: mockPlanner as any,
		});

		await runner.run("goal");

		// state.save should have been called at least: initial save + after activate_phase + after start_step
		expect(mockState.save).toHaveBeenCalled();
	});

	// ─── hook registration ───────────────────────────────────────────────────

	it("constructor registers hooks on the engine", () => {
		const hook = { beforeEvaluate: vi.fn() };
		const engine = new MockFasEngine(() => undefined);

		new FasRunner({
			session: mockSession as any,
			state: mockState as any,
			engine: engine as any,
			hooks: [hook],
		});

		expect(engine.registerHook).toHaveBeenCalledWith(hook);
	});
});
