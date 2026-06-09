/**
 * System prompt supplement builder for the active ferment.
 * Injects ferment state into the agent's system prompt via before_agent_start hook.
 *
 * When a ferment is active, injects the full state and next-action hint.
 * When idle, injects a proactive hint so the LLM knows ferment exists and
 * when to suggest it — proactive idle hint pattern.
 */

import type { BeforeAgentStartEventResult, ExtensionAPI } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import type { Ferment } from "../types.js";
import { getActive } from "./state.js";

/**
 * Proactive hint injected into the system prompt when no ferment is active.
 * Tells the LLM about ferment as an optional workflow for multi-phase tasks,
 * so it can suggest or initiate fermentation when appropriate.
 */
const IDLE_FERMENT_HINT = `## Ferment Workflow (optional)

Ferment is a structured plan → build → review workflow for multi-phase tasks. It tracks progress across phases and steps, with optional verification gates.

Before starting work, classify the user's request:
- Clear small task: handle inline.
- Substantive, multi-step, broad discovery, or explicit planning request: suggest ferment. Say something like "This looks like a multi-phase project — want me to set up a ferment to track progress?" If the user agrees, call \`ferment_new\` with the goal, then \`ferment_scope\` to plan phases.
- Vague non-ferment request: ask only decision-blocking clarification, then act inline.

Ferment lifecycle: call \`ferment_new\` → \`ferment_scope\` (define phases/steps) → \`ferment_activate_phase\` → work through steps → \`ferment_complete_ferment\`.
Use \`ferment_add_decision\` and \`ferment_add_memory\` to record key findings during execution.
Use the /ferment slash command to manage active ferments (pause, resume, progress, switch).`;

function getCurrentPhaseName(f: Ferment): string {
	if (!f.activePhaseId) return "none";
	const phase = f.phases.find(p => p.id === f.activePhaseId);
	return phase?.name ?? "none";
}

function buildFermentPromptBlock(): string {
	const f = getActive();
	if (!f) return IDLE_FERMENT_HINT;

	const action = whatNext(f);
	const lines: string[] = [
		`## Active Ferment: ${f.name}`,
		`Status: ${f.status}`,
		`Phase: ${f.activePhaseId ? getCurrentPhaseName(f) : "none"}`,
	];

	if (action) {
		lines.push(`Next Action: ${action.kind}`, `Instructions: ${action.message}`);
	} else {
		lines.push("All phases are complete. Ferment is terminal.");
	}

	lines.push(
		"",
		"Available ferment tools:",
		"- `ferment_new` — create a new draft ferment",
		"- `ferment_scope` — define goal, phases, and steps",
		"- `ferment_activate_phase` — activate a specific phase",
		"- `ferment_complete_ferment` — mark the ferment as complete",
		"- `ferment_pause` — pause the ferment",
		"- `ferment_resume` — resume a paused ferment",
		"- `ferment_start_step` — mark a step as running",
		"- `ferment_complete_step` — mark a step as complete",
		"- `ferment_verify_step` — run verification on a step",
		"- `ferment_fail_step` — mark a step as failed",
		"- `ferment_complete_phase` — mark a phase as complete",
		"- `ferment_skip_phase` / `ferment_fail_phase` — skip or fail a phase",
		"- `ferment_add_decision` — record an architectural decision",
		"- `ferment_add_memory` — record a pattern, gotcha, or convention",
		"- Use these tools to progress the ferment.",
	);

	return lines.join("\n");
}

/**
 * Register the before_agent_start hook to inject ferment state into system prompt.
 */
export function registerFermentPromptBlock(api: ExtensionAPI): void {
	api.on("before_agent_start", async (): Promise<BeforeAgentStartEventResult | undefined> => {
		const block = buildFermentPromptBlock();
		if (!block) return undefined;
		return { systemPrompt: [block] };
	});
}
