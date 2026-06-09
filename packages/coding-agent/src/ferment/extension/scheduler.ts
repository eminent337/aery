/**
 * Ferment wake-up scheduler.
 *
 * Sends an automated continuation nudge to the agent when:
 * 1. The continuation policy is "automated"
 * 2. The ferment is active (running or planned)
 * 3. The agent actually stalled (no tool calls on the last turn)
 *
 * In manual policy, no nudges are sent — the user must explicitly continue.
 */

import type { ExtensionAPI } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import { getActive, getContinuationPolicy } from "./state.js";

/**
 * Schedule a continuation nudge if the agent stalled on the last turn.
 * Call this from turn_end only when hasToolCall is false.
 */
export function scheduleFermentWakeUp(api: ExtensionAPI): void {
	const f = getActive();
	if (!f) return;
	if (getContinuationPolicy() !== "automated") return;
	if (f.status !== "running" && f.status !== "planned") return;

	const action = whatNext(f);
	if (!action) return;

	// Don't auto-nudge on terminal actions
	if (action.kind === "complete_ferment") return;

	const prefix =
		f.status === "running"
			? `RESUMING ferment "${f.name}" — the previous session was interrupted. Pick up the work immediately. Do NOT explain or summarize — execute the next action below.\n\n`
			: "";
	const msg = `${prefix}CONTINUING ferment "${f.name}". Action: ${action.kind}. ${action.message}`;

	api.sendMessage(
		{ content: msg, customType: "ferment_continue", display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
