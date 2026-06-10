/**
 * Ferment phase extension tools — activate, complete, skip, fail.
 * These wrap the state-machine + FermentStore for LLM-callable use via the ExtensionAPI.
 */

import type { ExtensionAPI } from "@aryee337/aery";
import type { AgentToolResult } from "@aryee337/aery-core";
import type { Ferment, FermentCommand } from "../../types.js";
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

function hintNext(f: Ferment): string {
	const action = whatNext(f);
	if (!action) return "";
	return `\n→ Next action: ${action.kind} — ${action.message}`;
}

function recoveryHint(err: string): string {
	if (err.includes("No active ferment")) return "\n💡 Call request_ferment_workflow first to create a ferment.";
	if (err.includes("not found")) return "\n💡 Check the phaseId — use the ID from ferment_scope or the previous tool response.";
	return "";
}

function errorWithRecovery(msg: string): AgentToolResult {
	return error(msg + recoveryHint(msg));
}

function successWithHint(content: string, f: Ferment): AgentToolResult {
	return success(content + hintNext(f));
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerPhaseTools(api: ExtensionAPI): void {
	const { z } = api.zod;

	// ── ferment_activate_phase ────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_activate_phase",
		label: "Ferment Activate Phase",
		description: "Activate a specific phase within the active ferment.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase to activate"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "activate_phase" }> = {
					type: "activate_phase",
					phaseId: params.phaseId,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const phase = result.phases.find(p => p.id === params.phaseId);
				const msg = phase ? `Phase ${phase.index} "${phase.name}" activated.` : `Phase activated.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_complete_phase ────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_complete_phase",
		label: "Ferment Complete Phase",
		description: "Mark the active phase as complete.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase to complete"),
			summary: z.string().optional().describe("Phase completion summary"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "complete_phase" }> = {
					type: "complete_phase",
					phaseId: params.phaseId,
					summary: params.summary ?? "",
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const nextPhase = result.phases.find(p => p.status === "active");
				const allDone = result.phases.every(
					p => p.status === "completed" || p.status === "skipped" || p.status === "failed",
				);
				let msg = `Phase marked complete.`;
				if (nextPhase) msg += ` Next: phase ${nextPhase.index} "${nextPhase.name}".`;
				if (allDone) msg += ` All phases done.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_skip_phase ────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_skip_phase",
		label: "Ferment Skip Phase",
		description: "Skip a planned phase.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase to skip"),
			reason: z.string().optional().describe("Reason for skipping"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "skip_phase" }> = {
					type: "skip_phase",
					phaseId: params.phaseId,
					reason: params.reason,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const skipped = result.phases.find(p => p.id === params.phaseId);
				const msg = skipped ? `Phase ${skipped.index} "${skipped.name}" skipped.` : `Phase skipped.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_fail_phase ────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_fail_phase",
		label: "Ferment Fail Phase",
		description: "Mark a phase as failed.",
		parameters: z.object({
			phaseId: z.string().describe("ID of the phase to fail"),
			reason: z.string().describe("Reason for failure"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive();
				const cmd: Extract<FermentCommand, { type: "fail_phase" }> = {
					type: "fail_phase",
					phaseId: params.phaseId,
					reason: params.reason,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				const failed = result.phases.find(p => p.id === params.phaseId);
				const msg = failed ? `Phase ${failed.index} "${failed.name}" marked failed.` : `Phase marked failed.`;
				return successWithHint(msg, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});
}