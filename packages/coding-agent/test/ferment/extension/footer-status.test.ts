import { beforeEach, describe, expect, it } from "bun:test";
import { formatFermentFooter } from "../../../src/ferment/extension/footer-status.js";
import { clearActive, setActive, setContinuationPolicy } from "../../../src/ferment/extension/state.js";
import type { Ferment, Phase, Step } from "../../../src/ferment/types.js";

const now = "2026-01-01T00:00:00.000Z";

function makeStep(id: string, index: number, description: string, status: Step["status"] = "pending"): Step {
	return { id, index, description, status };
}

function makePhase(id: string, index: number, name: string, status: Phase["status"], steps: Step[] = []): Phase {
	return { id, index, name, goal: "test goal", status, steps };
}

function makeFerment(id: string, name: string, status: Ferment["status"], phases: Phase[] = []): Ferment {
	return {
		id,
		name,
		status,
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases,
		decisions: [],
		memories: [],
		activePhaseId: phases.find(p => p.status === "active")?.id,
		createdAt: now,
		updatedAt: now,
	};
}

describe("formatFermentFooter", () => {
	beforeEach(() => {
		clearActive();
		setContinuationPolicy("manual");
	});

	it("no active ferment → visible: false", () => {
		const result = formatFermentFooter();
		expect(result.visible).toBe(false);
		expect(result.text).toBe("");
	});

	it("active ferment with no phases → correct text", () => {
		const f = makeFerment("f1", "My Ferment", "draft", []);
		setActive(f);
		setContinuationPolicy("manual");

		const result = formatFermentFooter();
		expect(result.visible).toBe(true);
		expect(result.text).toContain("Ferment: My Ferment");
		expect(result.text).toContain("draft");
		expect(result.text).toContain("scope");
		expect(result.text).toContain("manual");
	});

	it("active ferment with phases and steps → correct text", () => {
		const step1 = makeStep("s1", 1, "Do the thing", "done");
		const step2 = makeStep("s2", 2, "Check the thing", "pending");
		const phase1 = makePhase("p1", 1, "Implementation", "active", [step1, step2]);

		const f = makeFerment("f1", "StepFerment", "running", [phase1]);
		setActive(f);
		setContinuationPolicy("automated");

		const result = formatFermentFooter();
		expect(result.visible).toBe(true);
		expect(result.text).toContain("Ferment: StepFerment");
		expect(result.text).toContain("running");
		expect(result.text).toContain("Phase 1/1");
		expect(result.text).toContain("Steps 1/2");
		expect(result.text).toContain("auto");
	});

	it("all steps done → shows complete instead of action kind", () => {
		const step1 = makeStep("s1", 1, "Do the thing", "done");
		const step2 = makeStep("s2", 2, "Check the thing", "verified");
		const phase1 = makePhase("p1", 1, "Implementation", "active", [step1, step2]);

		const f = makeFerment("f1", "DoneFerment", "running", [phase1]);
		setActive(f);
		setContinuationPolicy("manual");

		const result = formatFermentFooter();
		expect(result.visible).toBe(true);
		expect(result.text).toContain("complete");
	});

	it("multiple phases → phase counter reflects active phase", () => {
		const phase1 = makePhase("p1", 1, "Planning", "completed", []);
		const phase2 = makePhase("p2", 2, "Implementation", "active", []);
		const f = makeFerment("f1", "MultiPhase", "running", [phase1, phase2]);
		setActive(f);
		setContinuationPolicy("manual");

		const result = formatFermentFooter();
		expect(result.text).toContain("Phase 2/2");
	});
});
