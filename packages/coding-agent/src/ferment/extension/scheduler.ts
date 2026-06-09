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

	const msg = `The ferment "${f.name}" is active. ` + `Next action: ${action.kind}. ${action.message}`;

	api.sendMessage(
		{ content: msg, customType: "ferment_continue", display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
