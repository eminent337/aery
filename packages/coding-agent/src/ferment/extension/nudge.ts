/**
 * Reactive continuation nudge for ferment.
 *
 * When the agent finishes a turn without making any tool calls,
 * this injects a follow-up nudge to keep it working on the ferment.
 * Respects continuation policy — stops at phase boundaries in manual mode.
 */

import type { ExtensionAPI } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import type { Ferment, FermentAction } from "../types.js";
import { getActive, getContinuationPolicy } from "./state.js";

const MAX_CONSECUTIVE_REACTIVE_NUDGES = 1;
const reactiveNudgeCounts = new Map<string, number>();

export function resetReactiveContinuationNudgeCount(fermentId: string): void {
	reactiveNudgeCounts.delete(fermentId);
}

export function resetAllReactiveContinuationNudgeCounts(): void {
	reactiveNudgeCounts.clear();
}

/**
 * Decides whether continuation should proceed, wait, or pause.
 * Mirrors Aery's decideContinuation logic.
 */
export function decideContinuation(
	f: Ferment,
	policy: string,
):
	| { type: "continue"; action: FermentAction }
	| { type: "wait_manual_boundary" }
	| { type: "paused" }
	| { type: "idle" } {
	if (f.status === "paused") {
		return { type: "paused" };
	}

	const action = whatNext(f);
	if (!action) return { type: "idle" };

	// Don't auto-nudge on terminal actions
	if (action.kind === "complete_ferment") return { type: "idle" };

	// Manual policy: stop at phase boundaries (activate_phase = new phase starting)
	if (policy === "manual" && action.kind === "activate_phase") {
		return { type: "wait_manual_boundary" };
	}

	return { type: "continue", action };
}

/**
 * If the agent just finished a turn without any tool calls and the ferment
 * is still active, inject a directive nudge to get it moving again.
 * Respects continuation policy — pauses at phase boundaries in manual mode.
 */
export function maybeInjectReactiveContinuationNudge(api: ExtensionAPI): void {
	const policy = getContinuationPolicy();
	if (policy !== "automated") return;

	const f = getActive();
	if (!f) return;
	if (f.status !== "running" && f.status !== "planned") return;

	const decision = decideContinuation(f, policy);
	if (decision.type !== "continue") return;

	const count = reactiveNudgeCounts.get(f.id) ?? 0;
	if (count >= MAX_CONSECUTIVE_REACTIVE_NUDGES) {
		// Stalled too many times — let the scheduler handle the next wake-up
		return;
	}

	reactiveNudgeCounts.set(f.id, count + 1);

	const action = decision.action;
	const msg = `CONTINUING ferment "${f.name}". Action: ${action.kind}. ${action.message}`;
	api.sendMessage(
		{ content: msg, customType: "ferment_continue", display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
