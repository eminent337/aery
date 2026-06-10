import type { MemoryCategory, StepResult } from "./types.js";

export interface ScopePhaseStepInput {
	description: string;
	verify?: string;
	parallel_group?: number;
}

export interface ScopePhaseInput {
	name: string;
	goal: string;
	description?: string;
	constraints?: string[];
	budget?: string;
	parallel_group?: number;
	steps?: ScopePhaseStepInput[];
}

export type FermentCommand =
	| { type: "oneShot"; goal: string; title?: string }
	| {
			type: "scope";
			title?: string;
			goal: string;
			successCriteria?: string[];
			constraints?: string[];
			phases: ScopePhaseInput[];
	  }
	| { type: "activate_phase"; phaseId: string }
	| { type: "activate_phase_group"; groupIndex: number }
	| { type: "refine_phase"; phaseId: string; steps: ScopePhaseStepInput[] }
	| { type: "complete_phase"; phaseId: string; summary: string }
	| { type: "skip_phase"; phaseId: string; reason?: string }
	| { type: "fail_phase"; phaseId: string; reason: string }
	| { type: "complete_step"; phaseId: string; stepId: string; result?: StepResult; summary?: string }
	| { type: "verify_step"; phaseId: string; stepId: string; result: StepResult; summary?: string }
	| { type: "skip_step"; phaseId: string; stepId: string }
	| { type: "fail_step"; phaseId: string; stepId: string; error?: string }
	| { type: "start_step"; phaseId: string; stepId: string }
	| { type: "complete_ferment"; finalSummary?: string }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "abandon"; reason?: string }
	| { type: "add_decision"; title: string; description: string; phaseId?: string; stepId?: string }
	| { type: "add_memory"; category: MemoryCategory; content: string; phaseId?: string; stepId?: string }
	| { type: "update_scope_field"; field: "goal" | "criteria" | "constraints"; value: string };
