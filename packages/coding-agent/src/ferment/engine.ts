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

// ─── Declarative Action Types ─────────────────────────────────────────────────

export type DeclarativeAction =
	| { kind: "scope"; reason: string }
	| { kind: "activate_phase"; phaseId: string; reason: string }
	| { kind: "refine"; phaseId: string; reason: string }
	| { kind: "start_step"; phaseId: string; stepId: string; reason: string; canParallel: boolean }
	| { kind: "complete_step"; phaseId: string; stepId: string; reason: string }
	| { kind: "verify_step"; phaseId: string; stepId: string; reason: string }
	| { kind: "complete_phase"; phaseId: string; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "complete_ferment"; reason: string }
	| { kind: "recover_step"; phaseId: string; stepId: string; reason: string }
	| { kind: "recover_phase"; phaseId: string; reason: string };

/**
 * Declarative next-action determination.
 * Reads ferment state and returns the next action without prose.
 * Reason is a one-sentence objective, not an instruction.
 * Priority-ordered conditions (higher priority first).
 */
export function determineNextAction(ferment: Ferment): DeclarativeAction | undefined {
	const active = findActivePhase(ferment);

	// 0. Terminal ferment status → no lifecycle action remains.
	if (ferment.status === "complete" || ferment.status === "abandoned") return undefined;

	// 1. No phases defined → scope (only if not paused)
	if (ferment.phases.length === 0) {
		if (ferment.status === "paused") {
			return { kind: "pause", reason: "ferment is paused" };
		}
		return { kind: "scope", reason: "collect goal, criteria, constraints, and phase breakdown" };
	}

	// 2. Ferment is paused
	if (ferment.status === "paused") {
		return { kind: "pause", reason: "ferment is paused" };
	}

	// 3. Failed phase → recover_phase. Must run before all-terminal
	// completion so failed phases can be retried or explicitly bypassed.
	const failedPhase = ferment.phases.find(p => p.status === "failed");
	if (failedPhase) {
		return { kind: "recover_phase", phaseId: failedPhase.id, reason: "handle failed phase" };
	}

	// 4. All phases terminal → complete_ferment
	const allPhasesTerminal = ferment.phases.every(
		p => p.status === "completed" || p.status === "skipped" || p.status === "failed",
	);
	if (allPhasesTerminal) {
		return { kind: "complete_ferment", reason: `all ${ferment.phases.length} phases are terminal` };
	}

	// 5. No active phase, ferment is planned → activate first planned
	if (!active && ferment.status === "planned") {
		const next = findFirstPlannedPhase(ferment);
		if (next) {
			return {
				kind: "activate_phase",
				phaseId: next.id,
				reason: "activate the first planned phase",
			};
		}
	}

	// 6. Running but no active phase (recovered state)
	if (ferment.status === "running" && !active) {
		return { kind: "pause", reason: "no active phase, recovered state" };
	}

	// 7. Active phase has no steps → refine
	if (active && active.steps.length === 0) {
		return { kind: "refine", phaseId: active.id, reason: "populate the active phase with concrete steps" };
	}

	// 8. Steps with failures → recover_step first
	if (active) {
		const failedStep = active.steps.find(s => s.status === "failed");
		if (failedStep) {
			return {
				kind: "recover_step",
				phaseId: active.id,
				stepId: failedStep.id,
				reason: "handle failed step",
			};
		}

		// 9. Steps pending → start first pending
		const nextStep = findNextStep(active);
		if (nextStep) {
			return {
				kind: "start_step",
				phaseId: active.id,
				stepId: nextStep.id,
				reason: "start the next pending step",
				canParallel: false,
			};
		}

		// 10. Running step with verification → verify_step
		const runningStep = active.steps.find(s => s.status === "running");
		if (runningStep?.verification) {
			return {
				kind: "verify_step",
				phaseId: active.id,
				stepId: runningStep.id,
				reason: "run verification for the running step",
			};
		}

		// 11. Step running → complete_step (SUGGESTION, caller decides when)
		if (runningStep) {
			return {
				kind: "complete_step",
				phaseId: active.id,
				stepId: runningStep.id,
				reason: "mark the running step as complete",
			};
		}

		// 11. All steps terminal → complete_phase
		const allStepsTerminal = active.steps.every(
			s => s.status === "done" || s.status === "skipped" || s.status === "verified" || s.status === "failed",
		);
		if (allStepsTerminal) {
			return {
				kind: "complete_phase",
				phaseId: active.id,
				reason: `mark phase ${active.index} as complete when all steps are terminal`,
			};
		}
	}

	// 12. No lifecycle action remains.
	return undefined;
}

/**
 * Convert a DeclarativeAction to a prose FermentAction.
 * Called by whatNext() to produce the legacy output format.
 */
export function declarativeToAction(action: DeclarativeAction, ferment: Ferment): FermentAction {
	const phase = "phaseId" in action ? ferment.phases.find(p => p.id === action.phaseId) : undefined;
	const step = phase && "stepId" in action ? phase.steps.find(s => s.id === action.stepId) : undefined;

	switch (action.kind) {
		case "scope":
			return { kind: "scope", message: buildScopeProse(ferment) };

		case "activate_phase":
			return {
				kind: "activate_phase",
				phaseId: action.phaseId,
				message: `Activate phase ${phase?.index}: "${phase?.name}"`,
			};

		case "refine":
			return {
				kind: "refine",
				phaseId: action.phaseId,
				message: `Break phase ${phase?.index} "${phase?.name}" into 3–6 concrete steps.`,
			};

		case "start_step":
			return {
				kind: "start_step",
				stepId: action.stepId,
				phaseId: action.phaseId,
				message: `Start step ${step?.index}: "${step?.description}"`,
			};

		case "complete_step":
			return {
				kind: "complete_step",
				stepId: action.stepId,
				phaseId: action.phaseId,
				message: `Complete step ${step?.index}: "${step?.description}"`,
			};

		case "verify_step":
			return {
				kind: "verify",
				stepId: action.stepId,
				phaseId: action.phaseId,
				message: `Verify step ${step?.index}: "${step?.description}"`,
			};

		case "complete_phase":
			return {
				kind: "complete_phase",
				phaseId: action.phaseId,
				message: `Mark phase ${phase?.index} "${phase?.name}" as complete.`,
			};

		case "pause":
			return { kind: "paused", message: "Ferment is paused." };

		case "complete_ferment":
			return {
				kind: "complete_ferment",
				message:
					ferment.status !== "running" && ferment.status !== "planned" && ferment.status !== "draft"
						? `Ferment is ${ferment.status}. All ${ferment.phases.length} phases complete.`
						: `All ${ferment.phases.length} phases complete. Mark ferment as complete.`,
			};

		case "recover_step":
			return {
				kind: "recover_step",
				phaseId: action.phaseId,
				stepId: action.stepId,
				message: `Step ${step?.index} "${step?.description}" failed.`,
			};

		case "recover_phase":
			return {
				kind: "recover_phase",
				phaseId: action.phaseId,
				message: `Phase ${phase?.index} "${phase?.name}" failed. Retry it with activate_ferment_phase, bypass it with skip_ferment_phase, or ask the user to run /ferment abandon if the ferment should stop.`,
			};
	}
}
// ─── Main Entry Point (prose) ─────────────────────────────────────────────────

/**
 * Reads canonical ferment state and returns the next action for the LLM.
 * Returns undefined when no lifecycle action remains (terminal state).
 *
 * Legacy prose-driven action. Prefer `determineNextAction` for programmatic use.
 */
export function whatNext(ferment: Ferment): FermentAction | undefined {
	const action = determineNextAction(ferment);
	if (!action) return undefined;
	return declarativeToAction(action, ferment);
}
