/**
 * Ferment step extension tools — start, complete, verify, skip, fail.
 * These wrap the state-machine + FermentStore for LLM-callable use via the ExtensionAPI.
 */

import type { ExtensionAPI } from "@aryee337/aery";
import type { AgentToolResult } from "@aryee337/aery-core";
import { whatNext } from "../../engine.js";
import { applyTransition } from "../../state-machine.js";
import { FermentStore } from "../../store.js";
import type { Ferment, FermentCommand, StepResult } from "../../types.js";
import { getActive, setActive } from "../state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function success(content: string): AgentToolResult {
	return { content: [{ type: "text", text: content }] };
}

function error(content: string): AgentToolResult {
	return { content: [{ type: "text", text: content }], isError: true };
}

function requireActive(): Ferment {
	const f = getActive();
	if (!f) throw new Error("No active ferment. Use ferment_scope first.");
	return f;
}

/** Resolve a phase identifier — try by ID first, then by name. */
function resolvePhaseId(f: Ferment, phaseIdOrName: string): string | undefined {
	const byId = f.phases.find(p => p.id === phaseIdOrName);
	if (byId) return byId.id;
	const byName = f.phases.find(p => p.name.toLowerCase() === phaseIdOrName.toLowerCase());
	if (byName) return byName.id;
	return undefined;
}

/** Resolve a step identifier — try by ID first, then by description (case-insensitive prefix match). */
function resolveStepId(f: Ferment, phaseId: string, stepIdOrDesc: string): string | undefined {
	const phase = f.phases.find(p => p.id === phaseId);
	if (!phase) return undefined;
	const byId = phase.steps.find(s => s.id === stepIdOrDesc);
	if (byId) return byId.id;
	const byDesc = phase.steps.find(s => s.description.toLowerCase().startsWith(stepIdOrDesc.toLowerCase()));
	if (byDesc) return byDesc.id;
	return undefined;
}

function buildStepResult(raw: { success: boolean; stdout?: string; stderr?: string; exitCode?: number }): StepResult {
	return { ...raw, completedAt: new Date().toISOString() };
}

function hintNext(f: Ferment): string {
	const action = whatNext(f);
	if (!action) return "";
	return `\n→ Next action: ${action.kind} — ${action.message}`;
}

function recoveryHint(err: string): string {
	if (err.includes("No active ferment")) return "\n💡 Call request_ferment_workflow first to create a ferment.";
	if (err.includes("not found")) return "\n💡 Check the phaseId/stepId or use a phase name / step description.";
	if (err.includes("STUCK_LOOP") || err.includes("started 3 times without completing"))
		return "\n💡 Ask the user how to proceed: retry with a revised approach, skip this step, or pause the ferment.";
	return "";
}

function errorWithRecovery(msg: string): AgentToolResult {
	return error(msg + recoveryHint(msg));
}

function errorWithCode(msg: string, code: string | undefined): AgentToolResult {
	return error(msg + recoveryHint(code ? `STUCK_LOOP: ${code}` : msg));
}

function successWithHint(content: string, f: Ferment): AgentToolResult {
	return success(content + hintNext(f));
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerStepTools(api: ExtensionAPI): void {
	const { z } = api.zod;
	api.registerTool({
		name: "ferment_start_step",
		label: "Ferment Start Step",
		description: "Mark a step as running. Accepts phase name and step description or ID.",
		parameters: z.object({
			phaseId: z.string().describe("Phase name or ID"),
			stepId: z.string().describe("Step ID or description prefix"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const pid = resolvePhaseId(ferment, params.phaseId);
				if (!pid) return errorWithRecovery(`Phase "${params.phaseId}" not found.`);
				const sid = resolveStepId(ferment, pid, params.stepId);
				if (!sid) return errorWithRecovery(`Step "${params.stepId}" not found.`);
				const cmd: Extract<FermentCommand, { type: "start_step" }> = {
					type: "start_step",
					phaseId: pid,
					stepId: sid,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithCode(result.error, result.code);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === pid);
				const step = phase?.steps.find(s => s.id === sid);
				const msg = step ? `Step ${step.index}: "${step.description}" started.` : `Step started.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_complete_step ─────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_complete_step",
		label: "Ferment Complete Step",
		description: "Mark a step as complete (done, not verified). Accepts phase name and step description or ID.",
		parameters: z.object({
			phaseId: z.string().describe("Phase name or ID"),
			stepId: z.string().describe("Step ID or description prefix"),
			summary: z.string().optional().describe("Step completion summary"),
			result: z
				.object({
					success: z.boolean().describe("Whether the step succeeded"),
					stdout: z.string().optional(),
					stderr: z.string().optional(),
					exitCode: z.number().optional(),
				})
				.optional()
				.describe("Step execution result"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const pid = resolvePhaseId(ferment, params.phaseId);
				if (!pid) return errorWithRecovery(`Phase "${params.phaseId}" not found.`);
				const sid = resolveStepId(ferment, pid, params.stepId);
				if (!sid) return errorWithRecovery(`Step "${params.stepId}" not found.`);
				const stepResult: StepResult | undefined = params.result ? buildStepResult(params.result) : undefined;

				const cmd: Extract<FermentCommand, { type: "complete_step" }> = {
					type: "complete_step",
					phaseId: pid,
					stepId: sid,
					result: stepResult,
					summary: params.summary,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === pid);
				const step = phase?.steps.find(s => s.id === sid);
				const status = step?.status === "verified" ? "verified" : "done";
				const msg = step ? `Step ${step.index} "${step.description}" marked ${status}.` : `Step marked ${status}.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});
	// ── ferment_verify_step ───────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_verify_step",
		label: "Ferment Verify Step",
		description:
			"Record a verification result for a step. Pass result.success=true for verified, " +
			"result.success=false for done (verification failed).",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase containing the step"),
			stepId: z.string().describe("ID of the step to verify"),
			result: z
				.object({
					success: z.boolean().describe("Whether verification passed"),
					stdout: z.string().optional(),
					stderr: z.string().optional(),
					exitCode: z.number().optional(),
				})
				.describe("Verification command result"),
			summary: z.string().optional().describe("Verification summary"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const stepResult = buildStepResult(params.result);

				const cmd: Extract<FermentCommand, { type: "verify_step" }> = {
					type: "verify_step",
					phaseId: params.phaseId,
					stepId: params.stepId,
					result: stepResult,
					summary: params.summary,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === params.phaseId);
				const step = phase?.steps.find(s => s.id === params.stepId);
				const status = step?.status === "verified" ? "verified" : "done (verification failed)";
				const msg = step ? `Step ${step.index} "${step.description}" — ${status}.` : `Verification recorded.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_skip_step ─────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_skip_step",
		label: "Ferment Skip Step",
		description: "Skip a step.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase containing the step"),
			stepId: z.string().describe("ID of the step to skip"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "skip_step" }> = {
					type: "skip_step",
					phaseId: params.phaseId,
					stepId: params.stepId,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === params.phaseId);
				const step = phase?.steps.find(s => s.id === params.stepId);
				const msg = step ? `Step ${step.index} "${step.description}" skipped.` : `Step skipped.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_fail_step ─────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_fail_step",
		label: "Ferment Fail Step",
		description: "Mark a step as failed.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase containing the step"),
			stepId: z.string().describe("ID of the step to fail"),
			error: z.string().optional().describe("Error message"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "fail_step" }> = {
					type: "fail_step",
					phaseId: params.phaseId,
					stepId: params.stepId,
					error: params.error,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === params.phaseId);
				const step = phase?.steps.find(s => s.id === params.stepId);
				const msg = step ? `Step ${step.index} "${step.description}" marked failed.` : `Step marked failed.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});
}
