/**
 * Ferment wake-up scheduler.
 *
 * Sends an automated continuation nudge to the agent when a ferment is
 * active and the continuation policy is "automated".
 */

import type { ExtensionAPI } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import { getActive, getContinuationPolicy } from "./state.js";

export function scheduleFermentWakeUp(api: ExtensionAPI, _fermentId?: string): void {
	const f = getActive();
	if (!f) return;
	if (getContinuationPolicy() !== "automated") return;

	const action = whatNext(f);
	if (!action) return;

	// Build a directive nudge — the agent must execute this action, not discuss it
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
