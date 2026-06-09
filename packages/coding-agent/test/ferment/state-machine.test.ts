import { describe, expect, it } from "bun:test";
import { applyTransition } from "../../src/ferment/state-machine.js";
import type { Ferment, Phase, Step } from "../../src/ferment/types.js";

// ─── Test fixture helpers ─────────────────────────────────────────────────────

function makeDraft(id = "f1"): Ferment {
	const now = "2026-01-01T00:00:00.000Z";
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

function makePhase(id: string, index: number, name: string, steps: Step[], groupIndex?: number): Phase {
	return { id, index, name, goal: "test goal", status: "planned", steps, groupIndex };
}

function makeStep(id: string, index: number, description: string): Step {
	return { id, index, description, status: "pending" };
}

// ─── Happy path: draft → planned → running → complete ───────────────────────

describe("happy path lifecycle", () => {
	it("scope transitions draft → planned", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "scope",
			goal: "Build a thing",
			phases: [{ name: "Phase 1", goal: "Do the thing" }],
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.status).toBe("planned");
		expect(result.phases).toHaveLength(1);
		expect(result.phases[0].status).toBe("planned");
	});

	it("scope sets name, goal, constraints", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "scope",
			title: "My Project",
			goal: "Ship it",
			successCriteria: ["criteria one", "criteria two"],
			constraints: ["constraint a"],
			phases: [{ name: "P1", goal: "goal" }],
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.name).toBe("My Project");
		expect(result.goal).toBe("Ship it");
		expect(result.successCriteria).toEqual(["criteria one", "criteria two"]);
		expect(result.constraints).toEqual(["constraint a"]);
	});

	it("activate_phase transitions planned → running", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "planned",
			phases: [makePhase("phase-1", 1, "P1", [])],
		};
		const result = applyTransition(f, { type: "activate_phase", phaseId: "phase-1" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.status).toBe("running");
		expect(result.phases[0].status).toBe("active");
		expect(result.activePhaseId).toBe("phase-1");
	});

	it("start_step transitions pending → running", () => {
		const step = makeStep("step-1", 1, "Do work");
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].steps[0].status).toBe("running");
	});

	it("complete_step marks step done", () => {
		const step = {
			...makeStep("step-1", 1, "Do work"),
			status: "running" as const,
			startedAt: "2026-01-01T00:00:00.000Z",
		};
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, {
			type: "complete_step",
			phaseId: "phase-1",
			stepId: "step-1",
			result: { success: false, completedAt: "2026-01-01T00:01:00.000Z" },
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].steps[0].status).toBe("done");
	});

	it("complete_step with success marks step verified", () => {
		const step = { ...makeStep("step-1", 1, "Do work"), status: "running" as const };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, {
			type: "complete_step",
			phaseId: "phase-1",
			stepId: "step-1",
			result: { success: true, completedAt: "2026-01-01T00:01:00.000Z" },
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].steps[0].status).toBe("verified");
	});

	it("complete_phase transitions phase → completed, sets next active", () => {
		const step = { ...makeStep("step-1", 1, "Do work"), status: "done" as const };
		const p1 = { ...makePhase("phase-1", 1, "P1", [step]), status: "active" as const };
		const p2 = { ...makePhase("phase-2", 2, "P2", []) };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [p1, p2],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].status).toBe("completed");
		expect(result.phases[1].status).toBe("active");
		expect(result.activePhaseId).toBe("phase-2");
		expect(result.status).toBe("running");
	});

	it("complete_ferment when all phases terminal", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [
				{ ...makePhase("phase-1", 1, "P1", []), status: "completed" },
				{ ...makePhase("phase-2", 2, "P2", []), status: "completed" },
			],
		};
		const result = applyTransition(f, { type: "complete_ferment" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.status).toBe("complete");
	});
});

// ─── Phase activation / deactivation ─────────────────────────────────────────

describe("phase activation", () => {
	it("activating a phase deactivates the previous one", () => {
		const p1 = { ...makePhase("phase-1", 1, "P1", []), status: "active" as const };
		const p2 = { ...makePhase("phase-2", 2, "P2", []), status: "planned" as const };
		const f: Ferment = { ...makeDraft(), status: "running", phases: [p1, p2], activePhaseId: "phase-1" };
		const result = applyTransition(f, { type: "activate_phase", phaseId: "phase-2" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].status).toBe("planned");
		expect(result.phases[1].status).toBe("active");
		expect(result.activePhaseId).toBe("phase-2");
	});

	it("scope fails on non-draft ferment", () => {
		const f: Ferment = { ...makeDraft(), status: "planned", phases: [] };
		const result = applyTransition(f, { type: "scope", goal: "x", phases: [{ name: "P1", goal: "g" }] });
		expect("error" in result).toBe(true);
	});

	it("activate_phase fails on completed phase", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", []), status: "completed" as const }],
		};
		const result = applyTransition(f, { type: "activate_phase", phaseId: "phase-1" });
		expect("error" in result).toBe(true);
	});

	it("activate_phase fails on non-existent phase", () => {
		const f: Ferment = { ...makeDraft(), status: "running", phases: [] };
		const result = applyTransition(f, { type: "activate_phase", phaseId: "does-not-exist" });
		expect("error" in result).toBe(true);
	});
});

// ─── Step lifecycle ───────────────────────────────────────────────────────────

describe("step lifecycle", () => {
	it("skip_step marks skipped", () => {
		const step = makeStep("step-1", 1, "Skip me");
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "skip_step", phaseId: "phase-1", stepId: "step-1" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].steps[0].status).toBe("skipped");
	});

	it("fail_step marks failed", () => {
		const step = { ...makeStep("step-1", 1, "Fail me"), status: "running" as const };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "fail_step", phaseId: "phase-1", stepId: "step-1", error: "boom" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].steps[0].status).toBe("failed");
		expect(result.phases[0].steps[0].result?.stderr).toBe("boom");
	});

	it("refine_phase fails when step is running", () => {
		const step = { ...makeStep("step-1", 1, "Running"), status: "running" as const };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, {
			type: "refine_phase",
			phaseId: "phase-1",
			steps: [{ description: "New step" }],
		});
		expect("error" in result).toBe(true);
	});
});

// ─── Parallel group handling ─────────────────────────────────────────────────

describe("parallel groups", () => {
	it("two steps with same groupIndex can both be running", () => {
		const s1 = { ...makeStep("step-1", 1, "A"), status: "running" as const, parallel: true, groupIndex: 1 };
		const s2 = { ...makeStep("step-2", 2, "B"), status: "pending" as const, parallel: true, groupIndex: 1 };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [s1, s2]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-2" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].steps[1].status).toBe("running");
	});

	it("non-parallel step blocks start of another step", () => {
		const s1 = { ...makeStep("step-1", 1, "A"), status: "running" as const };
		const s2 = { ...makeStep("step-2", 2, "B"), status: "pending" as const };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [s1, s2]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-2" });
		expect("error" in result).toBe(true);
	});

	it("activate_phase_group activates all phases in group", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [
				{ ...makePhase("phase-1", 1, "P1", []), status: "planned", groupIndex: 1 },
				{ ...makePhase("phase-2", 2, "P2", []), status: "planned", groupIndex: 1 },
				{ ...makePhase("phase-3", 3, "P3", []), status: "planned", groupIndex: 2 },
			],
		};
		const result = applyTransition(f, { type: "activate_phase_group", groupIndex: 1 });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.phases[0].status).toBe("active");
		expect(result.phases[1].status).toBe("active");
		expect(result.phases[2].status).toBe("planned");
	});
});

// ─── Memory and decisions ─────────────────────────────────────────────────────

describe("memory and decisions", () => {
	it("add_decision appends a decision", () => {
		const f = makeDraft();
		const result = applyTransition(f, { type: "add_decision", title: "Use X", description: "because Y" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.decisions).toHaveLength(1);
		expect(result.decisions[0].title).toBe("Use X");
		expect(result.decisions[0].id).toBe("D001");
	});

	it("add_memory appends a memory", () => {
		const f = makeDraft();
		const result = applyTransition(f, { type: "add_memory", category: "architecture", content: "Use A" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.memories).toHaveLength(1);
		expect(result.memories[0].content).toBe("Use A");
		expect(result.memories[0].id).toBe("M001");
	});

	it("add_memory rejects invalid category", () => {
		const f = makeDraft();
		const result = applyTransition(f, { type: "add_memory", category: "invalid" as any, content: "x" });
		expect("error" in result).toBe(true);
	});

	it("multiple decisions get incrementing IDs", () => {
		let f = makeDraft();
		f = applyTransition(f, { type: "add_decision", title: "D1", description: "" }) as Ferment;
		f = applyTransition(f, { type: "add_decision", title: "D2", description: "" }) as Ferment;
		expect(f.decisions[0].id).toBe("D001");
		expect(f.decisions[1].id).toBe("D002");
	});
});

// ─── Pause / resume / abandon ────────────────────────────────────────────────

describe("pause / resume / abandon", () => {
	it("pause resets running steps to pending", () => {
		const step = { ...makeStep("step-1", 1, "A"), status: "running" as const };
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
		const result = applyTransition(f, { type: "pause" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.status).toBe("paused");
		expect(result.phases[0].steps[0].status).toBe("pending");
	});

	it("pause fails from draft", () => {
		const f = makeDraft();
		const result = applyTransition(f, { type: "pause" });
		expect("error" in result).toBe(true);
	});

	it("resume restores running status", () => {
		const f: Ferment = { ...makeDraft(), status: "paused", phases: [] };
		const result = applyTransition(f, { type: "resume" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.status).toBe("planned");
	});

	it("abandon transitions to abandoned", () => {
		const f: Ferment = { ...makeDraft(), status: "running", phases: [] };
		const result = applyTransition(f, { type: "abandon", reason: "too hard" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.status).toBe("abandoned");
	});
});

// ─── Invalid transitions ──────────────────────────────────────────────────────

describe("invalid transitions", () => {
	it("complete_ferment fails if phases still active", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", []), status: "active" as const }],
		};
		const result = applyTransition(f, { type: "complete_ferment" });
		expect("error" in result).toBe(true);
	});

	it("complete_ferment fails if already complete", () => {
		const f: Ferment = { ...makeDraft(), status: "complete", phases: [] };
		const result = applyTransition(f, { type: "complete_ferment" });
		expect("error" in result).toBe(true);
	});

	it("complete_ferment fails if abandoned", () => {
		const f: Ferment = { ...makeDraft(), status: "abandoned", phases: [] };
		const result = applyTransition(f, { type: "complete_ferment" });
		expect("error" in result).toBe(true);
	});

	it("skip_phase fails on active phase", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", []), status: "active" as const }],
		};
		const result = applyTransition(f, { type: "skip_phase", phaseId: "phase-1" });
		expect("error" in result).toBe(true);
	});
});

// ─── Immutability ─────────────────────────────────────────────────────────────

describe("immutability", () => {
	it("original ferment is not mutated", () => {
		const f = makeDraft();
		const before = JSON.stringify(f);
		applyTransition(f, { type: "add_memory", category: "architecture", content: "x" });
		expect(JSON.stringify(f)).toBe(before);
	});

	it("original phase statuses are not mutated", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", []), status: "active" as const }],
		};
		const original = f.phases[0].status;
		applyTransition(f, { type: "activate_phase", phaseId: "phase-1" });
		expect(f.phases[0].status).toBe(original);
	});
});
