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

// ─── One-shot lifecycle ──────────────────────────────────────────────────────

describe("one-shot lifecycle", () => {
	it("oneShot transitions draft → running with a single phase and step", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "oneShot",
			goal: "Fix the login bug",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;

		// Ferment status
		expect(result.status).toBe("running");
		expect(result.goal).toBe("Fix the login bug");
		expect(result.name).toBe("Test Ferment"); // inherits from draft since no title

		// Phase structure
		expect(result.phases).toHaveLength(1);
		expect(result.phases[0].id).toBe("phase-1");
		expect(result.phases[0].name).toBe("Work");
		expect(result.phases[0].goal).toBe("Fix the login bug");
		expect(result.phases[0].status).toBe("active");
		expect(result.activePhaseId).toBe("phase-1");

		// Step structure
		const step = result.phases[0].steps[0];
		expect(step).toBeDefined();
		expect(step.id).toBe("step-1");
		expect(step.description).toBe("Fix the login bug");
		expect(step.status).toBe("running");
		expect(step.startedAt).toBeDefined();
	});

	it("oneShot with title sets ferment name", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "oneShot",
			title: "My One-shot",
			goal: "Refactor the API",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.name).toBe("My One-shot");
	});

	it("oneShot fails on non-draft ferment", () => {
		const f: Ferment = { ...makeDraft(), status: "running" };
		const result = applyTransition(f, {
			type: "oneShot",
			goal: "Won't work",
		});
		expect("error" in result).toBe(true);
	});

	it("oneShot ferment can complete the full lifecycle", () => {
		const f = makeDraft();
		const started = applyTransition(f, {
			type: "oneShot",
			goal: "Build feature X",
		});
		expect("error" in started).toBe(false);
		if ("error" in started) return;

		// Complete the step
		const stepDone = applyTransition(started, {
			type: "complete_step",
			phaseId: "phase-1",
			stepId: "step-1",
			result: { success: true, completedAt: "2026-01-01T00:01:00.000Z" },
		});
		expect("error" in stepDone).toBe(false);
		if ("error" in stepDone) return;
		expect(stepDone.phases[0].steps[0].status).toBe("verified");

		// Complete the phase
		const phaseDone = applyTransition(stepDone, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "All done",
		});
		expect("error" in phaseDone).toBe(false);
		if ("error" in phaseDone) return;
		expect(phaseDone.phases[0].status).toBe("completed");

		// Complete the ferment
		const complete = applyTransition(phaseDone, {
			type: "complete_ferment",
		});
		expect("error" in complete).toBe(false);
		if ("error" in complete) return;
		expect(complete.status).toBe("complete");
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

// ─── Update scope field ───────────────────────────────────────────────────────

describe("update_scope_field", () => {
	it("updates goal on a draft ferment", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "goal",
			value: "New goal",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.goal).toBe("New goal");
		expect(result.scoping.goal?.answer).toBe("New goal");
		expect(result.status).toBe("draft");
	});

	it("updates criteria on a draft ferment", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "criteria",
			value: "Criterion A",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.successCriteria).toEqual(["Criterion A"]);
		expect(result.scoping.criteria?.answer).toBe("Criterion A");
	});

	it("updates constraints on a draft ferment", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "constraints",
			value: "Constraint X",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.constraints).toEqual(["Constraint X"]);
		expect(result.scoping.constraints?.answer).toBe("Constraint X");
	});

	it("updates a field on a planned ferment", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "planned",
			goal: "Original goal",
			scoping: { goal: { answer: "Original goal", confirmedAt: "2026-01-01T00:00:00.000Z" } },
		};
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "goal",
			value: "Updated goal",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.goal).toBe("Updated goal");
		expect(result.scoping.goal?.answer).toBe("Updated goal");
		expect(result.status).toBe("planned");
	});

	it("rejects update on running ferment", () => {
		const f: Ferment = {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", []), status: "active" as const }],
		};
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "goal",
			value: "Should not work",
		});
		expect("error" in result).toBe(true);
	});

	it("rejects update on complete ferment", () => {
		const f: Ferment = { ...makeDraft(), status: "complete" };
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "goal",
			value: "Should not work",
		});
		expect("error" in result).toBe(true);
	});

	it("rejects invalid field name via TypeScript (runtime)", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "assumptions" as any,
			value: "Should fail",
		});
		expect("error" in result).toBe(true);
	});

	it("updates criteria with multi-line value", () => {
		const f = makeDraft();
		const result = applyTransition(f, {
			type: "update_scope_field",
			field: "criteria",
			value: "Criterion A\n- Criterion B\n* Criterion C",
		});
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.successCriteria).toEqual(["Criterion A", "Criterion B", "Criterion C"]);
		expect(result.scoping.criteria?.answer).toBe("Criterion A\n- Criterion B\n* Criterion C");
	});

	it("does not mutate original ferment", () => {
		const f = makeDraft();
		const before = JSON.stringify(f);
		applyTransition(f, {
			type: "update_scope_field",
			field: "goal",
			value: "New goal",
		});
		expect(JSON.stringify(f)).toBe(before);
	});
});

// ─── Stuck-loop detection ────────────────────────────────────────────────────

describe("stuck-loop detection", () => {
	function runningFerment(step: Step): Ferment {
		return {
			...makeDraft(),
			status: "running",
			phases: [{ ...makePhase("phase-1", 1, "P1", [step]), status: "active" }],
			activePhaseId: "phase-1",
		};
	}

	it("start_step 3 times without completing returns STUCK_LOOP error", () => {
		const step = makeStep("step-1", 1, "Stuck step");
		let f = runningFerment(step);

		// Start once -> startCount = 1
		f = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(1);
		expect(f.phases[0].steps[0].status).toBe("running");

		// Start again (step is still running) -> startCount = 2
		f = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(2);
		expect(f.phases[0].steps[0].status).toBe("running");

		// Start a third time -> STUCK_LOOP error
		const result = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" });
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect((result as any).code).toBe("STUCK_LOOP");
			expect(result.error).toContain("started 3 times");
		}
	});

	it("completing a step resets the start counter", () => {
		const step = makeStep("step-1", 1, "Reset step");
		let f = runningFerment(step);

		// Start twice (step stays running)
		f = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(1);
		f = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(2);

		// Complete it (terminal status) -> resets startCount
		f = applyTransition(f, {
			type: "complete_step",
			phaseId: "phase-1",
			stepId: "step-1",
			result: { success: true, completedAt: new Date().toISOString() },
		}) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(0);
		expect(f.phases[0].steps[0].status).toBe("verified");

		// Start again — should work fine (counter was reset)
		const result = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" });
		expect("error" in result).toBe(false);
		if (!("error" in result)) {
			expect(result.phases[0].steps[0].startCount).toBe(1);
		}
	});

	it("skipping a step resets the start counter, allowing fresh start", () => {
		const step = makeStep("step-1", 1, "Skip reset step");
		let f = runningFerment(step);

		// Start twice
		f = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(1);
		f = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(2);

		// Skip -> resets startCount to 0
		f = applyTransition(f, { type: "skip_step", phaseId: "phase-1", stepId: "step-1" }) as Ferment;
		expect(f.phases[0].steps[0].startCount).toBe(0);
		expect(f.phases[0].steps[0].status).toBe("skipped");

		// Start again after skip (counter was reset to 0)
		const result = applyTransition(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" });
		expect("error" in result).toBe(false);
		if (!("error" in result)) {
			expect(result.phases[0].steps[0].startCount).toBe(1);
		}
	});
});
