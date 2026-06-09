/**
 * Ferment Engine v1 — Forward State Machine
 *
 * Given a ferment state, returns the next action the LLM should take.
 * Pure — no I/O. All logic is deterministic and testable.
 *
 * Part of Aery's ferment system.
 */

import type { Ferment, FermentAction, Phase, Step } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findActivePhase(f: Ferment): Phase | undefined {
	if (f.activePhaseId) {
		const byId = f.phases.find(p => p.id === f.activePhaseId);
		if (byId?.status === "active") return byId;
	}
	return f.phases.find(p => p.status === "active");
}

function findFirstPlannedPhase(f: Ferment): Phase | undefined {
	return f.phases.find(p => p.status === "planned");
}

function findNextStep(p: Phase): Step | undefined {
	return p.steps.find(
		s =>
			s.status !== "done" &&
			s.status !== "skipped" &&
			s.status !== "verified" &&
			s.status !== "failed" &&
			s.status !== "running",
	);
}

function buildScopeProse(f: Ferment): string {
	const s = f.scoping;
	const missing: string[] = [];
	if (!s.goal) missing.push("goal");
	if (!s.criteria) missing.push("success criteria");
	if (!s.constraints) missing.push("constraints");
	if (!s.phases) missing.push("phase breakdown");

	if (missing.length === 0) {
		return `All scoping fields collected for ferment "${f.name}".`;
	}

	return `Define the ferment plan. Missing: ${missing.join(", ")}.`;
}

// ─── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Reads canonical ferment state and returns the next action for the LLM.
 * Returns undefined when no lifecycle action remains (terminal state).
 */
export function whatNext(ferment: Ferment): FermentAction | undefined {
	const active = findActivePhase(ferment);

	// 0. Terminal ferment status → no lifecycle action remains.
	if (ferment.status === "complete" || ferment.status === "abandoned") return undefined;

	// 1. No phases defined → scope (only if not paused)
	if (ferment.phases.length === 0) {
		if (ferment.status === "paused") {
			return { kind: "paused", message: "Ferment is paused." };
		}
		return { kind: "scope", message: buildScopeProse(ferment) };
	}

	// 2. Ferment is paused
	if (ferment.status === "paused") {
		return { kind: "paused", message: "Ferment is paused." };
	}

	// 3. Failed phase → recover_phase
	const failedPhase = ferment.phases.find(p => p.status === "failed");
	if (failedPhase) {
		return {
			kind: "recover_phase",
			phaseId: failedPhase.id,
			message: `Phase ${failedPhase.index} "${failedPhase.name}" failed.`,
		};
	}

	// 4. All phases terminal → complete_ferment
	const allPhasesTerminal = ferment.phases.every(
		p => p.status === "completed" || p.status === "skipped" || p.status === "failed",
	);
	if (allPhasesTerminal) {
		return {
			kind: "complete_ferment",
			message:
				ferment.status !== "running" && ferment.status !== "planned" && ferment.status !== "draft"
					? `Ferment is ${ferment.status}. All ${ferment.phases.length} phases complete.`
					: `All ${ferment.phases.length} phases complete. Mark ferment as complete.`,
		};
	}

	// 5. No active phase, ferment is planned → activate first planned
	if (!active && ferment.status === "planned") {
		const next = findFirstPlannedPhase(ferment);
		if (next) {
			return {
				kind: "activate_phase",
				phaseId: next.id,
				message: `Activate phase ${next.index}: "${next.name}"`,
			};
		}
	}

	// 6. Running but no active phase (recovered state)
	if (ferment.status === "running" && !active) {
		return { kind: "paused", message: "No active phase — recovered state." };
	}

	// 7. Active phase has no steps → refine
	if (active && active.steps.length === 0) {
		return {
			kind: "refine",
			phaseId: active.id,
			message: `Break phase ${active.index} "${active.name}" into 3–6 concrete steps.`,
		};
	}

	// 8. Active phase exists — walk step states
	if (active) {
		// 8a. Steps with failures → recover_step first
		const failedStep = active.steps.find(s => s.status === "failed");
		if (failedStep) {
			return {
				kind: "recover_step",
				stepId: failedStep.id,
				phaseId: active.id,
				message: `Step ${failedStep.index} "${failedStep.description}" failed.`,
			};
		}

		// 8b. Step needs verification
		const runningStep = active.steps.find(s => s.status === "running");
		if (runningStep?.verification) {
			return {
				kind: "verify",
				stepId: runningStep.id,
				phaseId: active.id,
				message: `Verify step ${runningStep.index}: "${runningStep.description}"`,
			};
		}

		// 8c. Steps pending → start first pending
		const nextStep = findNextStep(active);
		if (nextStep) {
			return {
				kind: "start_step",
				stepId: nextStep.id,
				phaseId: active.id,
				message: `Start step ${nextStep.index}: "${nextStep.description}"`,
			};
		}

		// 8d. Step running (no verification) → complete_step
		if (runningStep) {
			return {
				kind: "complete_step",
				stepId: runningStep.id,
				phaseId: active.id,
				message: `Complete step ${runningStep.index}: "${runningStep.description}"`,
			};
		}

		// 8e. All steps terminal → complete_phase
		const allStepsTerminal = active.steps.every(
			s => s.status === "done" || s.status === "skipped" || s.status === "verified" || s.status === "failed",
		);
		if (allStepsTerminal) {
			return {
				kind: "complete_phase",
				phaseId: active.id,
				message: `Mark phase ${active.index} "${active.name}" as complete.`,
			};
		}
	}

	// 9. No lifecycle action remains.
	return undefined;
}
