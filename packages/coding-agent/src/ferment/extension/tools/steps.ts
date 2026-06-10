/**
 * Ferment step extension tools — start, complete, verify, skip, fail.
 * These wrap the state-machine + FermentStore for LLM-callable use via the ExtensionAPI.
 */

import type { ExtensionAPI } from "@aryee337/aery";
import type { AgentToolResult } from "@aryee337/aery-core";
import type { Ferment, FermentCommand, StepResult } from "../../types.js";
import { whatNext } from "../../engine.js";
import { applyTransition } from "../../state-machine.js";
import { FermentStore } from "../../store.js";
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
	if (err.includes("not found")) return "\n💡 Check the phaseId/stepId — use the IDs from the previous tool response.";
	return "";
}

function errorWithRecovery(msg: string): AgentToolResult {
	return error(msg + recoveryHint(msg));
}

function successWithHint(content: string, f: Ferment): AgentToolResult {
	return success(content + hintNext(f));
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerStepTools(api: ExtensionAPI): void {
	const { z } = api.zod;

	// ── ferment_start_step ────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_start_step",
		label: "Ferment Start Step",
		description: "Mark a step as running.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase containing the step"),
			stepId: z.string().describe("ID of the step to start"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "start_step" }> = {
					type: "start_step",
					phaseId: params.phaseId,
					stepId: params.stepId,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === params.phaseId);
				const step = phase?.steps.find(s => s.id === params.stepId);
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
		description: "Mark a step as complete (done, not verified).",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase containing the step"),
			stepId: z.string().describe("ID of the step to complete"),
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
				const stepResult: StepResult | undefined = params.result ? buildStepResult(params.result) : undefined;

				const cmd: Extract<FermentCommand, { type: "complete_step" }> = {
					type: "complete_step",
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