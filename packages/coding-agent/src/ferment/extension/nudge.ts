/**
 * Reactive continuation nudge for ferment.
 *
 * When the agent finishes a turn without making any tool calls,
 * this injects a follow-up nudge to keep it working on the ferment.
 * Limits consecutive nudges to prevent infinite loops.
 */

import type { ExtensionAPI } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import { getActive, getContinuationPolicy } from "./state.js";

const MAX_CONSECUTIVE_REACTIVE_NUDGES = 1;
const reactiveNudgeCounts = new Map<string, number>();

export function resetReactiveContinuationNudgeCount(fermentId: string): void {
	reactiveNudgeCounts.delete(fermentId);
}

/**
 * If the agent just finished a turn without any tool calls and the ferment
 * is still active, inject a directive nudge to get it moving again.
 */
export function maybeInjectReactiveContinuationNudge(api: ExtensionAPI): void {
	if (getContinuationPolicy() !== "automated") return;
	const f = getActive();
	if (!f) return;
	if (f.status !== "running" && f.status !== "planned") return;

	const action = whatNext(f);
	if (!action) return;

	const count = reactiveNudgeCounts.get(f.id) ?? 0;
	if (count >= MAX_CONSECUTIVE_REACTIVE_NUDGES) {
		// Stalled too many times — let the scheduler handle the next wake-up
		return;
	}

	reactiveNudgeCounts.set(f.id, count + 1);

	const msg = `CONTINUING ferment "${f.name}". Action: ${action.kind}. ${action.message}`;
	api.sendMessage(
		{ content: msg, customType: "ferment_continue", display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
