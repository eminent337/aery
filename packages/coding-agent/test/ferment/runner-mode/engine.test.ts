import { describe, expect, it } from "bun:test";
import { FasEngine, type FasEngineHooks } from "../../../src/ferment/runner-mode/engine.js";
import type { Ferment, Phase, Step } from "../../../src/ferment/types.js";

const now = "2026-01-01T00:00:00.000Z";

function makeDraft(id = "f1"): Ferment {
	return {
		id,
		name: "Test Ferment",
		status: "draft",
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	};
}

function makePhase(id: string, index: number, name: string, status: Phase["status"], steps: Step[] = []): Phase {
	return { id, index, name, goal: "test goal", status, steps };
}

function makeStep(id: string, index: number, description: string, status: Step["status"] = "pending"): Step {
	return { id, index, description, status };
}

function makeRunning(phases: Phase[]): Ferment {
	return {
		id: "f1",
		name: "Test",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases,
		decisions: [],
		memories: [],
		activePhaseId: phases.find(p => p.status === "active")?.id,
		createdAt: now,
		updatedAt: now,
	};
}

// ─── FasEngine tests ───────────────────────────────────────────────────────────

describe("FasEngine", () => {
	describe("next() — action mapping", () => {
		it("returns activate_phase for a planned ferment with phases", () => {
			const ferment: Ferment = {
				...makeDraft(),
				status: "planned",
				phases: [makePhase("p1", 1, "Plan", "planned"), makePhase("p2", 2, "Build", "planned")],
			};
			const engine = new FasEngine(ferment);
			const action = engine.next();
			expect(action).not.toBeUndefined();
			expect(action!.kind).toBe("activate_phase");
			expect(action!.phaseId).toBe("p1");
			expect(typeof action!.message).toBe("string");
		});

		it("returns undefined for a complete ferment", () => {
			const ferment: Ferment = { ...makeDraft(), status: "complete" };
			const engine = new FasEngine(ferment);
			expect(engine.next()).toBeUndefined();
		});

		it("returns undefined for an abandoned ferment", () => {
			const ferment: Ferment = { ...makeDraft(), status: "abandoned" };
			const engine = new FasEngine(ferment);
			expect(engine.next()).toBeUndefined();
		});

		it("returns scope for a draft ferment with no phases", () => {
			const ferment = makeDraft();
			const engine = new FasEngine(ferment);
			const action = engine.next();
			expect(action?.kind).toBe("scope");
		});

		it("returns start_step for an active phase with pending steps", () => {
			const ferment = makeRunning([makePhase("p1", 1, "Plan", "active", [makeStep("s1", 1, "Write code")])]);
			const engine = new FasEngine(ferment);
			const action = engine.next();
			expect(action?.kind).toBe("start_step");
			expect(action!.stepId).toBe("s1");
		});

		it("returns complete_phase when all steps are terminal", () => {
			const ferment = makeRunning([
				makePhase("p1", 1, "Plan", "active", [makeStep("s1", 1, "Write code", "verified")]),
			]);
			const engine = new FasEngine(ferment);
			const action = engine.next();
			expect(action?.kind).toBe("complete_phase");
			expect(action!.phaseId).toBe("p1");
		});
	});

	describe("hooks", () => {
		it("fires beforeEvaluate hook", () => {
			const ferment = makeDraft();
			const engine = new FasEngine(ferment);
			let called = false;
			const hook: FasEngineHooks = {
				beforeEvaluate: () => {
					called = true;
				},
			};
			engine.registerHook(hook);
			engine.next();
			expect(called).toBe(true);
		});

		it("afterEvaluate hook can mutate the action", () => {
			const ferment: Ferment = {
				...makeDraft(),
				status: "planned",
				phases: [makePhase("p1", 1, "Plan", "planned")],
			};
			const engine = new FasEngine(ferment);
			const hook: FasEngineHooks = {
				afterEvaluate: (_f, action) => {
					if (action) {
						return { ...action, kind: action.kind, message: "mutated" };
					}
					return action;
				},
			};
			engine.registerHook(hook);
			const action = engine.next();
			expect(action?.message).toBe("mutated");
		});

		it("afterEvaluate returning undefined suppresses the action", () => {
			const ferment: Ferment = {
				...makeDraft(),
				status: "planned",
				phases: [makePhase("p1", 1, "Plan", "planned")],
			};
			const engine = new FasEngine(ferment);
			const hook: FasEngineHooks = {
				afterEvaluate: () => undefined,
			};
			engine.registerHook(hook);
			expect(engine.next()).toBeUndefined();
		});

		it("multiple hooks all fire in registration order", () => {
			const ferment = makeDraft();
			const engine = new FasEngine(ferment);
			const order: number[] = [];
			engine.registerHook({
				beforeEvaluate: () => {
					order.push(1);
				},
				afterEvaluate: (_f, action) => action,
			});
			engine.registerHook({
				beforeEvaluate: () => {
					order.push(2);
				},
				afterEvaluate: (_f, action) => action,
			});
			engine.next();
			expect(order).toEqual([1, 2]);
		});

		it("unsubscribe removes hook", () => {
			const ferment = makeDraft();
			const engine = new FasEngine(ferment);
			let called = false;
			const hook: FasEngineHooks = {
				beforeEvaluate: () => {
					called = true;
				},
			};
			const unsub = engine.registerHook(hook);
			unsub();
			engine.next();
			expect(called).toBe(false);
		});
	});

	describe("setFerment()", () => {
		it("uses updated ferment on next call", () => {
			const draft = makeDraft();
			const planned: Ferment = {
				...makeDraft(),
				status: "planned",
				phases: [makePhase("p1", 1, "Plan", "planned")],
			};
			const engine = new FasEngine(draft);
			expect(engine.next()?.kind).toBe("scope"); // draft → scope
			engine.setFerment(planned);
			expect(engine.next()?.kind).toBe("activate_phase"); // planned → activate_phase
		});
	});
});
