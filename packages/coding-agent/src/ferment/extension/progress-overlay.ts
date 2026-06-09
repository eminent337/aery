/**
 * Ferment progress overlay — interactive phase/step navigator and persistent widget.
 *
 * Two surfaces:
 * 1. **Popup** (`showProgressOverlay`) — invoked by `/ferment progress` or F6.
 *    Uses `ctx.ui.select()` to show a navigable phase/step tree.
 * 2. **Persistent widget** (`setProgressWidget` / `clearProgressWidget`) — renders
 *    a compact status panel above or below the editor via `ctx.ui.setWidget()`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ExtensionUISelectItem,
} from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import type { Ferment, Step } from "../types.js";
import { getActive } from "./state.js";

/* ── Icons ─────────────────────────────────────────────────────────────── */

const PHASE_ICON: Record<string, string> = {
	active: "▸",
	done: "✓",
	failed: "✗",
	skipped: "⊘",
	planned: "○",
};

const STEP_ICON: Record<string, string> = {
	done: "✓",
	verified: "✓✓",
	running: "▸",
	failed: "✗",
	skipped: "⊘",
	pending: "○",
};

function phaseIcon(status: string): string {
	return PHASE_ICON[status] ?? "○";
}

function stepIcon(status: string): string {
	return STEP_ICON[status] ?? "○";
}

/* ── Popup overlay (select) ────────────────────────────────────────────── */

export async function showProgressOverlay(ctx: ExtensionContext, api: ExtensionAPI): Promise<void> {
	const ferment = getActive();
	if (!ferment) {
		ctx.ui.notify("No active ferment.", "info");
		return;
	}

	const action = whatNext(ferment);
	const header = action ? `Ferment "${ferment.name}" — Next: ${action.kind}` : `Ferment "${ferment.name}" — Complete`;

	const { choices, lookup } = buildChoices(ferment);
	const selected = await ctx.ui.select(header, choices);
	if (!selected) return;

	const picked = lookup.get(selected);
	if (!picked?.stepId) return;

	const phase = ferment.phases.find(p => p.id === picked.phaseId);
	const step = phase?.steps.find(s => s.id === picked.stepId);
	if (step && phase) {
		const nudge = `User selected: focus on step "${step.description}" in phase "${phase.name}". Prioritize this step.`;
		api.sendMessage({ content: nudge, customType: "ferment_progress_focus", display: false }, { triggerTurn: true });
	}
}

function buildChoices(ferment: Ferment): {
	choices: ExtensionUISelectItem[];
	lookup: Map<string, { phaseId: string; stepId?: string }>;
} {
	const choices: ExtensionUISelectItem[] = [];
	const lookup = new Map<string, { phaseId: string; stepId?: string }>();

	for (let i = 0; i < ferment.phases.length; i++) {
		const phase = ferment.phases[i]!;
		const label = `${i + 1}. ${phaseIcon(phase.status)} ${phase.name}`;
		const desc = phase.status + (phase.goal ? ` — ${phase.goal}` : "");
		choices.push({ label, description: desc });
		lookup.set(label, { phaseId: phase.id });

		for (let j = 0; j < phase.steps.length; j++) {
			const step = phase.steps[j]!;
			const stepLabel = `   ${j + 1}. ${stepIcon(step.status)} ${step.description}`;
			const stepDesc = step.status + (step.summary ? ` — ${step.summary}` : "");
			choices.push({ label: stepLabel, description: stepDesc });
			lookup.set(stepLabel, { phaseId: phase.id, stepId: step.id });
		}
	}
	return { choices, lookup };
}

/* ── Persistent widget ─────────────────────────────────────────────────── */

function getStepDescription(step: Step): string {
	return step.description ?? "(no description)";
}

export function setProgressWidget(ui: ExtensionUIContext): void {
	const ferment = getActive();
	if (!ferment) return;

	const action = whatNext(ferment);
	const phaseIdx = ferment.activePhaseId ? ferment.phases.findIndex(p => p.id === ferment.activePhaseId) + 1 : 0;
	const totalPhases = ferment.phases.length;
	const stepsDone = ferment.phases.reduce(
		(acc, p) => acc + p.steps.filter(s => s.status === "done" || s.status === "verified").length,
		0,
	);
	const totalSteps = ferment.phases.reduce((acc, p) => acc + p.steps.length, 0);

	const parts: string[] = [`${ferment.name} · ${ferment.status}`];
	if (totalPhases > 0) parts.push(`Phase ${phaseIdx}/${totalPhases}`);
	if (totalSteps > 0) parts.push(`Steps ${stepsDone}/${totalSteps}`);
	if (action) parts.push(`Next: ${action.kind}`);

	ui.setWidget("ferment-progress", parts, { placement: "belowEditor" });
}

export function clearProgressWidget(ui: ExtensionUIContext): void {
	ui.setWidget("ferment-progress", undefined);
}
