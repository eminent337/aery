import { describe, expect, it } from "bun:test";
import { whatNext } from "../../src/ferment/engine.js";
import type { Ferment, Phase, Step } from "../../src/ferment/types.js";

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

// ─── whatNext tests ────────────────────────────────────────────────────────────

describe("whatNext", () => {
	it("draft ferment → scope", () => {
		const f = makeDraft();
		const action = whatNext(f);
		expect(action?.kind).toBe("scope");
	});

	it("draft ferment with no goal → scope with missing fields", () => {
		const f = makeDraft();
		const action = whatNext(f) as { kind: "scope"; message: string };
		expect(action.kind).toBe("scope");
		expect(action.message).toContain("goal");
	});

	it("planned ferment with phases → activate_phase (first planned)", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "planned",
			phases: [makePhase("p1", 1, "Plan", "planned"), makePhase("p2", 2, "Build", "planned")],
		};
		const action = whatNext(f);
		expect(action?.kind).toBe("activate_phase");
		expect((action as any).phaseId).toBe("p1");
	});

	it("running with no active phase → paused (recovered state)", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [makePhase("p1", 1, "Plan", "planned"), makePhase("p2", 2, "Build", "planned")],
		};
		const action = whatNext(f);
		expect(action?.kind).toBe("paused");
	});

	it("active phase with no steps → refine", () => {
		const f = makeRunning([makePhase("p1", 1, "Plan", "active", [])]);
		const action = whatNext(f);
		expect(action?.kind).toBe("refine");
	});

	it("active phase with pending step → start_step", () => {
		const f = makeRunning([makePhase("p1", 1, "Plan", "active", [makeStep("s1", 1, "Write code")])]);
		const action = whatNext(f);
		expect(action?.kind).toBe("start_step");
		expect((action as any).stepId).toBe("s1");
	});

	it("running step with verification → verify", () => {
		const step: Step = {
			id: "s1",
			index: 1,
			description: "Write tests",
			status: "running",
			verification: { command: "npm test" },
		};
		const f = makeRunning([makePhase("p1", 1, "Plan", "active", [step])]);
		const action = whatNext(f);
		expect(action?.kind).toBe("verify");
		expect((action as any).stepId).toBe("s1");
	});

	it("running step without verification → complete_step", () => {
		const f = makeRunning([makePhase("p1", 1, "Plan", "active", [makeStep("s1", 1, "Write code", "running")])]);
		const action = whatNext(f);
		expect(action?.kind).toBe("complete_step");
	});

	it("all steps terminal → complete_phase", () => {
		const f = makeRunning([makePhase("p1", 1, "Plan", "active", [makeStep("s1", 1, "Write code", "verified")])]);
		const action = whatNext(f);
		expect(action?.kind).toBe("complete_phase");
	});

	it("all phases terminal → complete_ferment", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [makePhase("p1", 1, "Plan", "completed", [makeStep("s1", 1, "Write code", "verified")])],
		};
		const action = whatNext(f);
		expect(action?.kind).toBe("complete_ferment");
	});

	it("paused ferment → paused", () => {
		const f: Ferment = { ...makeDraft(), status: "paused" };
		const action = whatNext(f);
		expect(action?.kind).toBe("paused");
	});

	it("complete ferment → undefined", () => {
		const f: Ferment = { ...makeDraft(), status: "complete" };
		expect(whatNext(f)).toBeUndefined();
	});

	it("abandoned ferment → undefined", () => {
		const f: Ferment = { ...makeDraft(), status: "abandoned" };
		expect(whatNext(f)).toBeUndefined();
	});

	it("failed step → recover_step", () => {
		const f = makeRunning([makePhase("p1", 1, "Plan", "active", [makeStep("s1", 1, "Write code", "failed")])]);
		const action = whatNext(f);
		expect(action?.kind).toBe("recover_step");
		expect((action as any).stepId).toBe("s1");
	});

	it("failed phase → recover_phase", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [
				makePhase("p1", 1, "Plan", "failed", [makeStep("s1", 1, "Write code", "failed")]),
				makePhase("p2", 2, "Build", "planned"),
			],
		};
		const action = whatNext(f);
		expect(action?.kind).toBe("recover_phase");
		expect((action as any).phaseId).toBe("p1");
	});
});
