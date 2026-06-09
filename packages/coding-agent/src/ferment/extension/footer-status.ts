/**
 * Footer status display for the active ferment.
 *
 * Formats the current ferment state into a compact status string
 * shown in the UI status bar.
 */

import { whatNext } from "../engine.js";
import { getActive, getContinuationPolicy } from "./state.js";

export interface FermentFooterDisplay {
	text: string;
	visible: boolean;
}

export function formatFermentFooter(): FermentFooterDisplay {
	const f = getActive();
	if (!f) return { text: "", visible: false };

	const action = whatNext(f);
	const policy = getContinuationPolicy();
	const phaseIdx = f.activePhaseId ? f.phases.findIndex(p => p.id === f.activePhaseId) + 1 : 0;
	const totalPhases = f.phases.length;
	const stepsDone = f.phases.reduce(
		(acc, p) => acc + p.steps.filter(s => s.status === "done" || s.status === "verified").length,
		0,
	);
	const totalSteps = f.phases.reduce((acc, p) => acc + p.steps.length, 0);

	const parts = [`Ferment: ${f.name}`, `${f.status}`, action ? `${action.kind}` : "complete"];
	if (totalPhases > 0) parts.push(`Phase ${phaseIdx}/${totalPhases}`);
	if (totalSteps > 0) parts.push(`Steps ${stepsDone}/${totalSteps}`);
	parts.push(policy === "automated" ? "auto" : "manual");

	return { text: parts.join(" · "), visible: true };
}
