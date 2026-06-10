// Ferment state machine — pure transition logic, zero I/O.
// Aery ferment state machine — pure transition logic, zero I/O.

import type {
	Ferment,
	FermentCommand,
	JudgeGrade,
	Phase,
	PhaseStatus,
	ScopingAnswer,
	Step,
	StepResult,
	StepStatus,
} from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ["done", "verified", "skipped", "failed"];
const TERMINAL_PHASE_STATUSES: readonly PhaseStatus[] = ["completed", "skipped", "failed"];
const VALID_MEMORY_CATEGORIES = ["architecture", "convention", "gotcha", "pattern", "preference"] as const;

// ─── Public entry point ───────────────────────────────────────────────────────

export function applyTransition(ferment: Ferment, cmd: FermentCommand): Ferment | { error: string; code?: string } {
	const now = new Date().toISOString();

	switch (cmd.type) {
		case "oneShot":
			return hOneShot(ferment, cmd, now);
		case "scope":
			return hScope(ferment, cmd, now);
		case "activate_phase":
			return hActivatePhase(ferment, cmd.phaseId, now);
		case "activate_phase_group":
			return hActivatePhaseGroup(ferment, cmd.groupIndex, now);
		case "refine_phase":
			return hRefinePhase(ferment, cmd.phaseId, cmd.steps, now);
		case "complete_phase":
			return hCompletePhase(ferment, cmd.phaseId, cmd.summary, now);
		case "skip_phase":
			return hSkipPhase(ferment, cmd.phaseId, cmd.reason, now);
		case "fail_phase":
			return hFailPhase(ferment, cmd.phaseId, cmd.reason, now);
		case "start_step":
			return hStartStep(ferment, cmd.phaseId, cmd.stepId, now);
		case "complete_step":
			return hCompleteStep(ferment, cmd.phaseId, cmd.stepId, cmd.result, cmd.summary, now);
		case "verify_step":
			return hVerifyStep(ferment, cmd.phaseId, cmd.stepId, cmd.result, cmd.summary, now);
		case "skip_step":
			return hSkipStep(ferment, cmd.phaseId, cmd.stepId, now);
		case "fail_step":
			return hFailStep(ferment, cmd.phaseId, cmd.stepId, cmd.error, now);
		case "complete_ferment":
			return hCompleteFerment(ferment);
		case "pause":
			return hPause(ferment, now);
		case "resume":
			return hResume(ferment, now);
		case "abandon":
			return hAbandon(ferment, cmd.reason, now);
		case "add_decision":
			return hAddDecision(ferment, cmd.title, cmd.description, cmd.phaseId, cmd.stepId, now);
		case "add_memory":
			return hAddMemory(ferment, cmd.category, cmd.content, cmd.phaseId, cmd.stepId, now);
		case "update_scope_field":
			return hUpdateScopeField(ferment, cmd, now);
		case "rename":
			return hRename(ferment, cmd.name, now);
		case "set_phase_grade":
			return hSetPhaseGrade(ferment, cmd.phaseId, cmd.grade, now);
		case "set_step_grade":
			return hSetStepGrade(ferment, cmd.phaseId, cmd.stepId, cmd.grade, now);
		case "set_ferment_grade":
			return hSetFermentGrade(ferment, cmd.grade, now);
		case "update_step_description":
			return hUpdateStepDescription(ferment, cmd.phaseId, cmd.stepId, cmd.description, now);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function touch(f: Ferment, now: string, patch: Partial<Ferment> = {}): Ferment {
	return { ...f, ...patch, updatedAt: now };
}

function requireFermentStatus(f: Ferment, expected: string[]): { error: string } | null {
	if (expected.includes(f.status)) return null;
	return { error: `Ferment is "${f.status}", expected ${expected.map(s => `"${s}"`).join(" or ")}.` };
}

function findPhase(f: Ferment, phaseId: string): { phase: Phase; index: number } | { error: string } {
	const index = f.phases.findIndex(p => p.id === phaseId);
	if (index < 0) return { error: `Phase "${phaseId}" not found.` };
	return { phase: f.phases[index], index };
}

function requirePhaseStatus(phase: Phase, expected: PhaseStatus[]): { error: string } | null {
	if (expected.includes(phase.status)) return null;
	return { error: `Phase "${phase.id}" is "${phase.status}", expected ${expected.map(s => `"${s}"`).join(" or ")}.` };
}

function findStep(phase: Phase, stepId: string): { step: Step; index: number } | { error: string } {
	const index = phase.steps.findIndex(s => s.id === stepId);
	if (index < 0) return { error: `Step "${stepId}" not found in phase "${phase.id}".` };
	return { step: phase.steps[index], index };
}

function mapPhases(f: Ferment, fn: (p: Phase, i: number) => Phase): Ferment {
	return touch(f, new Date().toISOString(), { phases: f.phases.map(fn) });
}

function setPhase(f: Ferment, idx: number, patch: Partial<Phase>): Ferment {
	return mapPhases(f, (p, i) => (i === idx ? { ...p, ...patch } : p));
}

function setStep(f: Ferment, pIdx: number, sIdx: number, patch: Partial<Step>): Ferment {
	return mapPhases(f, (p, aery) => {
		if (aery !== pIdx) return p;
		return { ...p, steps: p.steps.map((s, si) => (si === sIdx ? { ...s, ...patch } : s)) };
	});
}

function settleAfterPhaseTerminal(phases: Phase[]): Pick<Ferment, "phases" | "status" | "activePhaseId"> {
	const active = phases.find(p => p.status === "active");
	if (active) return { phases, status: "running", activePhaseId: active.id };
	const pending = phases.find(p => p.status === "planned");
	if (pending) {
		const now = new Date().toISOString();
		return { phases: activateSinglePhase(phases, pending.id, now), status: "running", activePhaseId: pending.id };
	}
	return { phases, status: "planned", activePhaseId: undefined };
}

function activateSinglePhase(phases: Phase[], phaseId: string, now: string): Phase[] {
	return phases.map(p => {
		if (p.id === phaseId) return { ...p, status: "active", startedAt: now };
		if (p.status === "active") return { ...p, status: "planned" };
		return p;
	});
}

// ─── Success criteria helpers (ported from success-criteria.ts) ───────────────

function normalizeSuccessCriteria(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const items = value.map((v: unknown) => (typeof v === "string" ? (v as string).trim() : "")).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const items = trimmed
		.split(/\r?\n/)
		.map(s => s.replace(/^[-*]\s+/, "").trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function successCriteriaToAnswer(criteria: string[]): string | undefined {
	if (!criteria || criteria.length === 0) return undefined;
	return criteria.join("\n");
}

// ─── Cohort resolution ───────────────────────────────────────────────────────

interface CohortFlags {
	parallel: boolean;
	groupIndex?: number;
}

function resolveCohorts(groups: (number | undefined)[]): CohortFlags[] {
	const counts = new Map<number, number>();
	for (const g of groups) {
		if (g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
	}
	return groups.map(g => {
		const isMember = g !== undefined && (counts.get(g) ?? 0) >= 2;
		return { parallel: isMember, groupIndex: isMember ? g : undefined };
	});
}

function buildSteps(inputs: { description: string; verify?: string; parallel_group?: number }[]): Step[] {
	const cohorts = resolveCohorts(inputs.map(s => s.parallel_group));
	return inputs.map((st, i) => ({
		id: `step-${i + 1}`,
		index: i + 1,
		description: st.description,
		status: "pending" as StepStatus,
		verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
		...cohorts[i],
	}));
}

function buildPhases(
	inputs: {
		name: string;
		goal: string;
		description?: string;
		constraints?: string[];
		budget?: string;
		parallel_group?: number;
		steps?: { description: string; verify?: string; parallel_group?: number }[];
	}[],
): Phase[] {
	const cohorts = resolveCohorts(inputs.map(p => p.parallel_group));
	return inputs.map((p, i) => {
		const steps = buildSteps(p.steps ?? []);
		return {
			id: `phase-${i + 1}`,
			index: i + 1,
			name: p.name,
			goal: p.goal,
			description: p.description ?? "",
			constraints: p.constraints,
			budget: p.budget,
			...cohorts[i],
			status: "planned" as PhaseStatus,
			steps,
		};
	});
}

// ─── Command handlers ─────────────────────────────────────────────────────────

/**
 * One-shot transition: creates a fully-scoped, activated, and started ferment
 * from a draft. Combines scope → activate_phase → start_step into one step.
 */
function hOneShot(
	f: Ferment,
	cmd: Extract<FermentCommand, { type: "oneShot" }>,
	now: string,
): Ferment | { error: string; code?: string } {
	// 1. Scope the draft with a single phase/step
	const scoped = hScope(
		f,
		{
			type: "scope",
			title: cmd.title,
			goal: cmd.goal,
			phases: [
				{
					name: "Work",
					goal: cmd.goal,
					steps: [{ description: cmd.goal }],
				},
			],
		},
		now,
	);
	if ("error" in scoped) return scoped;

	// 2. Activate the first (and only) phase
	const activated = hActivatePhase(scoped, "phase-1", now);
	if ("error" in activated) return activated;

	// 3. Start the first (and only) step
	const started = hStartStep(activated, "phase-1", "step-1", now);
	if ("error" in started) return started;

	return started;
}

function hScope(f: Ferment, cmd: Extract<FermentCommand, { type: "scope" }>, now: string): Ferment | { error: string } {
	const bad = requireFermentStatus(f, ["draft"]);
	if (bad) return bad;

	const phases = buildPhases(cmd.phases);
	const scoping = { ...f.scoping };
	scoping.goal = { answer: cmd.goal, confirmedAt: now };
	const sc = normalizeSuccessCriteria(cmd.successCriteria);
	if (sc) scoping.criteria = { answer: successCriteriaToAnswer(sc) ?? "", confirmedAt: now };
	if (cmd.constraints?.length) scoping.constraints = { answer: cmd.constraints.join(", "), confirmedAt: now };
	if (phases.length) scoping.phases = { answer: phases.map(p => p.name).join(", "), confirmedAt: now };

	return touch(f, now, {
		name: cmd.title ?? f.name,
		goal: cmd.goal,
		successCriteria: sc,
		constraints: cmd.constraints,
		scoping,
		phases,
		status: "planned",
	});
}

function hActivatePhase(f: Ferment, phaseId: string, now: string): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const bad = requirePhaseStatus(found.phase, ["planned", "failed"]);
	if (bad) return bad;
	const phases = activateSinglePhase(f.phases, phaseId, now);
	return touch(f, now, { phases, activePhaseId: phaseId, status: "running" });
}

function hActivatePhaseGroup(f: Ferment, groupIndex: number, now: string): Ferment | { error: string } {
	const groupPhases = f.phases.filter(p => p.groupIndex === groupIndex && p.status === "planned");
	if (groupPhases.length === 0) return { error: `No planned phases in group ${groupIndex}.` };
	const phases = f.phases.map(p => {
		if (p.groupIndex === groupIndex && p.status === "planned")
			return { ...p, status: "active" as PhaseStatus, startedAt: now };
		if (p.status === "active" && p.groupIndex !== groupIndex) return { ...p, status: "planned" as PhaseStatus };
		return p;
	});
	return touch(f, now, { phases, activePhaseId: groupPhases[0].id, status: "running" });
}

function hRefinePhase(
	f: Ferment,
	phaseId: string,
	steps: { description: string; verify?: string; parallel_group?: number }[],
	_now: string,
): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const bad = requirePhaseStatus(found.phase, ["active"]);
	if (bad) return bad;
	const running = found.phase.steps.find(s => s.status === "running");
	if (running)
		return {
			error: `Cannot refine phase ${found.phase.index} — step ${running.index} ("${running.description}") is running. Complete, skip, or fail it first.`,
		};
	const newSteps = buildSteps(steps);
	return setPhase(f, found.index, { steps: newSteps });
}

function hStartStep(
	f: Ferment,
	phaseId: string,
	stepId: string,
	now: string,
): Ferment | { error: string; code?: string } {
	const pf = findPhase(f, phaseId);
	if ("error" in pf) return pf;
	const sf = findStep(pf.phase, stepId);
	if ("error" in sf) return sf;

	const currentStartCount = sf.step.startCount ?? 0;
	const newStartCount = currentStartCount + 1;

	if (newStartCount >= 3) {
		return {
			error: `Step has been started ${newStartCount} times without completing. Ask the user: should we retry with a revised approach, skip this step, or pause the ferment?`,
			code: "STUCK_LOOP",
		};
	}

	const alreadyRunning = pf.phase.steps.find(s => s.status === "running" && s.id !== stepId);
	if (
		alreadyRunning &&
		!(alreadyRunning.parallel && sf.step.parallel && alreadyRunning.groupIndex === sf.step.groupIndex)
	) {
		return {
			error: `Cannot start step ${sf.step.index} — step ${alreadyRunning.index} ("${alreadyRunning.description}") is already running and is not in the same parallel group.`,
		};
	}
	return setStep(f, pf.index, sf.index, { status: "running", startedAt: now, startCount: newStartCount });
}

function hCompleteStep(
	f: Ferment,
	phaseId: string,
	stepId: string,
	result: StepResult | undefined,
	summary: string | undefined,
	now: string,
): Ferment | { error: string } {
	const pf = findPhase(f, phaseId);
	if ("error" in pf) return pf;
	const sf = findStep(pf.phase, stepId);
	if ("error" in sf) return sf;
	const status: StepStatus = result?.success ? "verified" : "done";
	return setStep(f, pf.index, sf.index, { status, completedAt: now, result, summary, startCount: 0 });
}

function hVerifyStep(
	f: Ferment,
	phaseId: string,
	stepId: string,
	result: StepResult,
	summary: string | undefined,
	now: string,
): Ferment | { error: string } {
	const pf = findPhase(f, phaseId);
	if ("error" in pf) return pf;
	const sf = findStep(pf.phase, stepId);
	if ("error" in sf) return sf;
	const status: StepStatus = result.success ? "verified" : "done";
	return setStep(f, pf.index, sf.index, {
		status,
		completedAt: now,
		result: { ...result, completedAt: now },
		summary,
		startCount: 0,
	});
}

function hSkipStep(f: Ferment, phaseId: string, stepId: string, now: string): Ferment | { error: string } {
	const pf = findPhase(f, phaseId);
	if ("error" in pf) return pf;
	const sf = findStep(pf.phase, stepId);
	if ("error" in sf) return sf;
	return setStep(f, pf.index, sf.index, { status: "skipped", completedAt: now, startCount: 0 });
}

function hFailStep(
	f: Ferment,
	phaseId: string,
	stepId: string,
	error: string | undefined,
	now: string,
): Ferment | { error: string } {
	const pf = findPhase(f, phaseId);
	if ("error" in pf) return pf;
	const sf = findStep(pf.phase, stepId);
	if ("error" in sf) return sf;
	const result: StepResult | undefined = error ? { success: false, stderr: error, completedAt: now } : undefined;
	return setStep(f, pf.index, sf.index, { status: "failed", completedAt: now, result, startCount: 0 });
}

function hCompletePhase(f: Ferment, phaseId: string, summary: string, now: string): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const bad = requirePhaseStatus(found.phase, ["active"]);
	if (bad) return bad;
	const patch = { status: "completed" as PhaseStatus, summary, completedAt: now };
	return touch(f, now, settleAfterPhaseTerminal(setPhase(f, found.index, patch).phases));
}

function hSkipPhase(f: Ferment, phaseId: string, reason: string | undefined, now: string): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const bad = requirePhaseStatus(found.phase, ["planned"]);
	if (bad) return bad;
	const patch = { status: "skipped" as PhaseStatus, summary: reason ?? "Skipped", completedAt: now };
	return touch(f, now, settleAfterPhaseTerminal(setPhase(f, found.index, patch).phases));
}

function hFailPhase(f: Ferment, phaseId: string, reason: string, now: string): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const patch = { status: "failed" as PhaseStatus, summary: reason, completedAt: now };
	return touch(f, now, settleAfterPhaseTerminal(setPhase(f, found.index, patch).phases));
}

function hCompleteFerment(f: Ferment): Ferment | { error: string } {
	if (f.status === "complete") return { error: `Ferment "${f.name}" is already complete.` };
	if (f.status === "abandoned") return { error: `Ferment "${f.name}" is abandoned and cannot be completed.` };
	const nonTerminal = f.phases.filter(p => !TERMINAL_PHASE_STATUSES.includes(p.status));
	if (nonTerminal.length > 0) {
		return {
			error: `Cannot complete: ${nonTerminal.length} phase(s) still active or planned: ${nonTerminal.map(p => `"${p.name}"`).join(", ")}`,
		};
	}
	return touch(f, new Date().toISOString(), { status: "complete" });
}

function hPause(f: Ferment, now: string): Ferment | { error: string } {
	const bad = requireFermentStatus(f, ["running", "planned"]);
	if (bad) return bad;
	const phases = f.phases.map(p => ({
		...p,
		steps: p.steps.map(s => (s.status === "running" ? { ...s, status: "pending" as StepStatus } : s)),
	}));
	return touch(f, now, { status: "paused", phases });
}

function hResume(f: Ferment, now: string): Ferment | { error: string } {
	const bad = requireFermentStatus(f, ["paused"]);
	if (bad) return bad;
	const active = f.phases.find(p => p.status === "active");
	return touch(f, now, { status: active ? "running" : "planned", activePhaseId: active?.id });
}

function hAbandon(f: Ferment, _reason: string | undefined, now: string): Ferment | { error: string } {
	return touch(f, now, { status: "abandoned" });
}

function hUpdateScopeField(
	f: Ferment,
	cmd: Extract<FermentCommand, { type: "update_scope_field" }>,
	now: string,
): Ferment | { error: string } {
	const bad = requireFermentStatus(f, ["draft", "planned"]);
	if (bad) return bad;

	const scoping = { ...f.scoping };
	const answer: ScopingAnswer = { answer: cmd.value, confirmedAt: now };

	switch (cmd.field) {
		case "goal": {
			scoping.goal = answer;
			return touch(f, now, { goal: cmd.value, scoping });
		}
		case "criteria": {
			scoping.criteria = answer;
			const criteria = cmd.value
				.split(/\r?\n/)
				.map(s => s.replace(/^[-*]\s+/, "").trim())
				.filter(Boolean);
			return touch(f, now, { successCriteria: criteria, scoping });
		}
		case "constraints": {
			scoping.constraints = answer;
			const constraints = cmd.value
				.split(/\r?\n/)
				.map(s => s.replace(/^[-*]\s+/, "").trim())
				.filter(Boolean);
			return touch(f, now, { constraints, scoping });
		}
		default:
			return { error: `Invalid field "${cmd.field}". Use "goal", "criteria", or "constraints".` };
	}
}

function hAddDecision(
	f: Ferment,
	title: string,
	description: string,
	phaseId: string | undefined,
	stepId: string | undefined,
	now: string,
): Ferment | { error: string } {
	const maxIdx = f.decisions.reduce<number>((m, d) => {
		const n = Number.parseInt(d.id.slice(1), 10);
		return Number.isFinite(n) && n > m ? n : m;
	}, 0);
	const decision = {
		id: `D${String(maxIdx + 1).padStart(3, "0")}`,
		title,
		description,
		phaseId,
		stepId,
		createdAt: now,
	};
	return touch(f, now, { decisions: [...f.decisions, decision] });
}

function hAddMemory(
	f: Ferment,
	category: string,
	content: string,
	phaseId: string | undefined,
	stepId: string | undefined,
	now: string,
): Ferment | { error: string } {
	if (!VALID_MEMORY_CATEGORIES.includes(category as (typeof VALID_MEMORY_CATEGORIES)[number])) {
		return { error: `Invalid category "${category}". Use one of: ${VALID_MEMORY_CATEGORIES.join(", ")}.` };
	}
	const maxIdx = f.memories.reduce<number>((m, mem) => {
		const n = Number.parseInt(mem.id.slice(1), 10);
		return Number.isFinite(n) && n > m ? n : m;
	}, 0);
	const memory = {
		id: `M${String(maxIdx + 1).padStart(3, "0")}`,
		category: category as any,
		content,
		phaseId,
		stepId,
		createdAt: now,
	};
	return touch(f, now, { memories: [...f.memories, memory] });
}

// ─── Rename ────────────────────────────────────────────────────────────────────

function hRename(f: Ferment, name: string, now: string): Ferment | { error: string } {
	if (!name.trim()) return { error: "Name cannot be empty." };
	return touch(f, now, { name: name.trim() });
}

// ─── Grade commands ────────────────────────────────────────────────────────────

function hSetPhaseGrade(f: Ferment, phaseId: string, grade: JudgeGrade, now: string): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const phases = f.phases.map((p, i) => (i === found.index ? { ...p, grade } : p));
	return touch(f, now, { phases });
}

function hSetStepGrade(
	f: Ferment,
	phaseId: string,
	stepId: string,
	grade: JudgeGrade,
	now: string,
): Ferment | { error: string } {
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const sf = found.phase.steps.find(s => s.id === stepId);
	if (!sf) return { error: `Step "${stepId}" not found in phase "${phaseId}".` };
	const sIdx = found.phase.steps.indexOf(sf);
	const steps = found.phase.steps.map((s, i) => (i === sIdx ? { ...s, grade } : s));
	const phases = f.phases.map((p, i) => (i === found.index ? { ...p, steps } : p));
	return touch(f, now, { phases });
}

function hSetFermentGrade(f: Ferment, grade: JudgeGrade, now: string): Ferment | { error: string } {
	return touch(f, now, { grade });
}
// ─── Update step description ──────────────────────────────────────────────────

function hUpdateStepDescription(
	f: Ferment,
	phaseId: string,
	stepId: string,
	description: string,
	now: string,
): Ferment | { error: string } {
	if (!description.trim()) return { error: "Step description cannot be empty." };
	const found = findPhase(f, phaseId);
	if ("error" in found) return found;
	const sf = found.phase.steps.find(s => s.id === stepId);
	if (!sf) return { error: `Step "${stepId}" not found in phase "${phaseId}".` };
	const sIdx = found.phase.steps.indexOf(sf);
	const steps = found.phase.steps.map((s, i) => (i === sIdx ? { ...s, description: description.trim() } : s));
	const phases = f.phases.map((p, i) => (i === found.index ? { ...p, steps } : p));
	return touch(f, now, { phases });
}
