// Ferment core types — Chunk 1
// Convention: type aliases for simple unions, interface for objects.

export type FermentStatus = "draft" | "planned" | "running" | "paused" | "complete" | "abandoned";
export type PhaseStatus = "planned" | "active" | "completed" | "skipped" | "failed";
export type StepStatus = "pending" | "running" | "done" | "skipped" | "verified" | "failed";
export type Grade = "A" | "B" | "C" | "D" | "F";
export type MemoryCategory = "architecture" | "convention" | "gotcha" | "pattern" | "preference";

export interface FermentWorktree {
	path: string;
	branch?: string;
	commit?: string;
}

export interface ScopingAnswer {
	answer: string;
	confirmedAt: string;
}

export interface Scoping {
	goal?: ScopingAnswer;
	criteria?: ScopingAnswer;
	constraints?: ScopingAnswer;
	phases?: ScopingAnswer;
}

export interface Ferment {
	id: string;
	name: string;
	status: FermentStatus;
	goal?: string;
	successCriteria?: string[];
	constraints?: string[];
	worktree: FermentWorktree;
	scoping: Scoping;
	phases: Phase[];
	decisions: Decision[];
	memories: Memory[];
	grade?: JudgeGrade;
	activePhaseId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Phase {
	id: string;
	index: number;
	name: string;
	goal: string;
	status: PhaseStatus;
	steps: Step[];
	parallel?: boolean;
	groupIndex?: number;
	startedAt?: string;
	completedAt?: string;
	summary?: string;
	grade?: JudgeGrade;
	description?: string;
	constraints?: string[];
	budget?: string;
}

export interface Step {
	id: string;
	index: number;
	description: string;
	status: StepStatus;
	verification?: Verification;
	result?: StepResult;
	summary?: string;
	startedAt?: string;
	completedAt?: string;
	parallel?: boolean;
	groupIndex?: number;
	grade?: JudgeGrade;
}

export interface Verification {
	command: string;
	retries?: number;
	retryDelayMs?: number;
}

export interface StepResult {
	success: boolean;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	completedAt: string;
}

export interface Decision {
	id: string;
	title: string;
	description: string;
	phaseId?: string;
	stepId?: string;
	createdAt: string;
}

export interface Memory {
	id: string;
	category: MemoryCategory;
	content: string;
	phaseId?: string;
	stepId?: string;
	createdAt: string;
}

export interface JudgeGrade {
	grade: Grade;
	rationale: string;
	gradedAt: string;
}

/** True when both items are members of the same non-singleton parallel group. */
export function inSameParallelCohort(
	a: { parallel?: boolean; groupIndex?: number },
	b: { parallel?: boolean; groupIndex?: number },
): boolean {
	return !!a.parallel && !!b.parallel && a.groupIndex !== undefined && a.groupIndex === b.groupIndex;
}

/**
 * All action kinds produced by `whatNext()`. Each member is a discriminated union
 * with `kind`, optional `phaseId`/`stepId`, and a human-readable `message`.
 */
export type FermentAction =
	| { kind: "scope"; message: string }
	| { kind: "paused"; message: string }
	| { kind: "recover_phase"; phaseId: string; message: string }
	| { kind: "complete_ferment"; message: string }
	| { kind: "activate_phase"; phaseId: string; message: string }
	| { kind: "refine"; phaseId: string; message: string }
	| { kind: "recover_step"; stepId: string; phaseId: string; message: string }
	| { kind: "verify"; phaseId: string; stepId: string; message: string }
	| { kind: "start_step"; phaseId: string; stepId: string; message: string }
	| { kind: "complete_step"; phaseId: string; stepId: string; message: string }
	| { kind: "complete_phase"; phaseId: string; message: string };

export * from "./commands.js";
