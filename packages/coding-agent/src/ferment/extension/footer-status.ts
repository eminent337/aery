/**
 * Footer status display for the active ferment.
 *
 * Formats the current ferment state into a compact status string
 * shown in the UI status bar. Modeled after Aery's footer: name, status,
 * continuation policy — clean and simple.
 */

import { getActive, getContinuationPolicy } from "./state.js";

export interface FermentFooterDisplay {
	text: string;
	visible: boolean;
}

const STATUS_LABELS: Record<string, string> = {
	draft: "Draft",
	planned: "Planned",
	running: "Running",
	paused: "Paused",
	complete: "Complete",
	abandoned: "Abandoned",
};

export function canToggleFermentStopPolicy(fermentStatus?: string): boolean {
	return fermentStatus === "planned" || fermentStatus === "running" || fermentStatus === "paused";
}

export function formatFermentFooter(): FermentFooterDisplay {
	const f = getActive();
	if (!f || f.status === "complete" || f.status === "abandoned") return { text: "", visible: false };

	const policy = getContinuationPolicy();
	const statusLabel = STATUS_LABELS[f.status] ?? f.status;
	const parts = [`Ferment: ${f.name}`, statusLabel];

	if (canToggleFermentStopPolicy(f.status)) {
		parts.push(policy === "automated" ? "Auto" : "Stop: Phase Boundary");
	}

	return { text: parts.join(" · "), visible: true };
}
