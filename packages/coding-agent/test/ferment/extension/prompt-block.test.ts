/**
 * Tests for the ferment prompt block, including context budget tracking.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { buildFermentPromptBlock } from "../../../src/ferment/extension/prompt-block.js";
import { clearActive, resetTurnCount, setActive, setTurnCount } from "../../../src/ferment/extension/state.js";
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

beforeEach(() => {
	clearActive();
	resetTurnCount();
});

describe("buildFermentPromptBlock", () => {
	it("returns idle hint when no active ferment", () => {
		const result = buildFermentPromptBlock();
		expect(result).toContain("Ferment Workflow");
	});

	it("returns planning supplement for draft ferment without context line", () => {
		const f = makeFerment("f1", "Test Ferment", "draft");
		setActive(f);
		const result = buildFermentPromptBlock();
		expect(result).toContain("Ferment Planning");
		expect(result).not.toContain("Context:");
	});

	it("returns planning supplement for planned ferment without context line", () => {
		const f = makeFerment("f1", "Test Ferment", "planned");
		setActive(f);
		const result = buildFermentPromptBlock();
		expect(result).toContain("Ferment Ready");
		expect(result).not.toContain("Context:");
	});

	it("returns paused warning without context line", () => {
		const f = makeFerment("f1", "Test Ferment", "paused");
		setActive(f);
		const result = buildFermentPromptBlock();
		expect(result).toContain("Ferment Paused");
		expect(result).not.toContain("Context:");
	});

	it("returns empty string for complete ferment", () => {
		const f = makeFerment("f1", "Test Ferment", "complete");
		setActive(f);
		const result = buildFermentPromptBlock();
		expect(result).toBe("");
	});

	it("returns empty string for abandoned ferment", () => {
		const f = makeFerment("f1", "Test Ferment", "abandoned");
		setActive(f);
		const result = buildFermentPromptBlock();
		expect(result).toBe("");
	});
});

describe("context budget line — running ferment", () => {
	it("includes context line when ferment is running", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		const result = buildFermentPromptBlock();
		expect(result).toContain("Context:");
		expect(result).toContain("turns");
	});

	it("shows normal text for < 30 turns", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(14);

		const result = buildFermentPromptBlock();
		expect(result).toContain("Context: 14 turns");
		expect(result).not.toContain("— growing");
		expect(result).not.toContain("⚠");
	});

	it("shows growing warning for 30-49 turns", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(38);

		const result = buildFermentPromptBlock();
		expect(result).toContain("Context: 38 turns — growing");
		expect(result).not.toContain("⚠");
	});

	it("shows growing warning at exactly 30 turns (boundary)", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(30);

		const result = buildFermentPromptBlock();
		expect(result).toContain("Context: 30 turns — growing");
	});

	it("shows growing warning at exactly 49 turns (boundary)", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(49);

		const result = buildFermentPromptBlock();
		expect(result).toContain("Context: 49 turns — growing");
	});

	it("shows alert with warning emoji for 50+ turns", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(52);

		const result = buildFermentPromptBlock();
		expect(result).toContain("⚠ Context: 52 turns — consider /compact");
	});

	it("shows alert at exactly 50 turns (boundary)", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(50);

		const result = buildFermentPromptBlock();
		expect(result).toContain("⚠ Context: 50 turns — consider /compact");
	});

	it("shows normal text for 0 turns", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(0);

		const result = buildFermentPromptBlock();
		expect(result).toContain("Context: 0 turns");
	});

	it("context line appears after status header and before planner role", () => {
		const phase = makePhase("p1", 0, "Setup", "active", [makeStep("s1", 0, "Install deps", "pending")]);
		const f = makeFerment("f1", "Test Ferment", "running", [phase]);
		setActive(f);
		setTurnCount(5);

		const result = buildFermentPromptBlock();
		const headerEnd = result.indexOf("Next Action:");
		const contextLineStart = result.indexOf("Context: 5 turns");
		const plannerRoleStart = result.indexOf("Ferment Planner Role");

		expect(headerEnd).toBeGreaterThan(0);
		expect(contextLineStart).toBeGreaterThan(headerEnd);
		expect(plannerRoleStart).toBeGreaterThan(contextLineStart);
	});
});
