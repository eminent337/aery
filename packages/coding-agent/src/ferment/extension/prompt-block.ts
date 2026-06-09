/**
 * System prompt supplement builder for the active ferment.
 * Injects ferment state into the agent's system prompt via before_agent_start hook.
 *
 * When a ferment is active, injects the planner role + state machine directives.
 * When idle, injects a directive hint so the LLM knows to request ferment
 * for substantive tasks — modeled after Aery's approach.
 */

import type { BeforeAgentStartEventResult, ExtensionAPI } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import type { Ferment } from "../types.js";
import { getActive } from "./state.js";

/**
 * Directive hint injected when no ferment is active.
 * Forces the agent to classify the request before doing any work.
 */
const IDLE_FERMENT_HINT = `## Ferment Workflow (optional)

Ferment is a structured plan → build → review workflow for multi-phase tasks. It tracks progress across phases and steps, with optional verification gates. Start it only with \`request_ferment_workflow\`. The tool asks the user for confirmation before creating the workflow.

Before starting work, classify the user's request:
- Clear small task: handle inline.
- Substantive, multi-step, broad discovery, or explicit planning request: call \`request_ferment_workflow\` with a concise title and the full user intent. Then stop.
- Vague non-ferment request: ask only decision-blocking clarification, then act inline.
Do not call analysis tools or file reads *until* you have classified the request and either called \`request_ferment_workflow\`, chosen inline work, or asked necessary non-ferment clarification.
Treat open-ended analysis of an existing app as substantive: call \`request_ferment_workflow\` before analysis, file reads, or phase tagging.

Call \`request_ferment_workflow\` with a concise \`title\` and an \`intent\` containing the full original user request, then stop; the host handles confirmation and queues scoping. If the user declines, continue inline. Never block on this.

Lifecycle: \`request_ferment_workflow\` → \`ferment_scope\` → \`ferment_activate_phase\` → \`ferment_start_step\` → \`ferment_complete_step\` → \`ferment_complete_phase\` → \`ferment_complete_ferment\`.
Use \`ferment_add_decision\` and \`ferment_add_memory\` to record key findings during execution.
Use the /ferment slash command to manage active ferments (pause, resume, progress, switch).`;

/**
 * Format decisions and memories for the planner supplement.
 */
function formatDecisionsAndMemories(f: Ferment): string {
	const parts: string[] = [];
	if (f.decisions.length > 0) {
		const items = f.decisions.map(d => `- **${d.title}**: ${d.description}`).join("\n");
		parts.push(`**Decisions:**\n${items}`);
	}
	if (f.memories.length > 0) {
		const items = f.memories.map(m => `- [${m.category}] ${m.content}`).join("\n");
		parts.push(`**Memories:**\n${items}`);
	}
	return parts.join("\n\n");
}

/**
 * Build the scoping context summary (phases, steps, progress).
 */
function buildScopingSummary(f: Ferment): string {
	const totalPhases = f.phases.length;
	const totalSteps = f.phases.reduce((acc, p) => acc + p.steps.length, 0);
	const doneSteps = f.phases.reduce(
		(acc, p) => acc + p.steps.filter(s => s.status === "done" || s.status === "verified").length,
		0,
	);
	const completedPhases = f.phases.filter(p => p.status === "completed").length;

	return `${completedPhases}/${totalPhases} phases complete, ${doneSteps}/${totalSteps} steps done`;
}

/**
 * Build the Planner Role prompt when a ferment is active.
 * Modeled after Aery's buildPlannerSupplement.
 */
function buildPlannerRole(f: Ferment): string {
	const action = whatNext(f);
	const dm = formatDecisionsAndMemories(f);
	const dmSection = dm ? `\n\n${dm}` : "";
	const progress = buildScopingSummary(f);

	const actionInstructions = (() => {
		if (!action) return "";

		switch (action.kind) {
			case "scope":
				return `\n\n**Scoping:**\nCall \`ferment_scope\` NOW with: goal, successCriteria, constraints, and phases (each with name, goal, and steps array). Do not explain — just call it.`;
			case "start_step":
				return `\n\nCall \`ferment_start_step\` with phaseId "${action.phaseId}" and stepId "${action.stepId}", then execute the step.`;
			case "complete_step":
				return `\n\nCall \`ferment_complete_step\` with phaseId "${action.phaseId}", stepId "${action.stepId}", and a summary of what was done.`;
			case "complete_phase":
				return `\n\nCall \`ferment_complete_phase\` with phaseId "${action.phaseId}".`;
			case "complete_ferment":
				return `\n\nCall \`ferment_complete_ferment\` with a final summary of all work done.`;
			case "activate_phase":
				return `\n\nCall \`ferment_activate_phase\` with phaseId "${action.phaseId}" to begin work.`;
			case "refine":
				return `\n\nBreak phase ${action.phaseId} into 3–6 concrete steps by calling \`ferment_refine_phase\`.`;
			case "verify":
				return `\n\nCall \`ferment_verify_step\` with phaseId "${action.phaseId}", stepId "${action.stepId}", and the verification result.`;
			default:
				return "";
		}
	})();

	return `## Ferment Planner Role

You are the PLANNER for ferment "${f.name}". Your job is to manage the task graph and see each phase through to completion.

**Progress:** ${progress}

**State machine:**
- Read the next-action hint from the tool result, then execute that action directly
- Continue across phase boundaries whenever the next-action hint names another lifecycle tool
- Do not ask the user to confirm phase advancement or step results
- Continue across phases until the ferment is complete, blocked, paused, or needs user input

**Rules:**
- For each step: call the appropriate tool, do the work, then complete the step
- Capture architectural decisions via \`ferment_add_decision\` — especially pivots that affect future phases
- Capture gotchas, conventions, and reusable patterns via \`ferment_add_memory\`
- Surface blockers only when you cannot proceed without human input
- Use the /ferment slash command for status, pause, resume, or abandon

**Upfront Contract:**
Treat the Ferment Specification (goal, success criteria, constraints) as the agreed plan. Proceed with your highest-confidence interpretation and capture uncertainty via \`ferment_add_decision\` or \`ferment_add_memory\`. Surface blockers only when you cannot proceed without human input.
${actionInstructions}${dmSection}`;
}

/**
 * Build the paused warning.
 */
function buildPausedWarning(f: Ferment): string {
	return `## Ferment Paused

Ferment "${f.name}" is paused by the user. Do NOT call any ferment tools — they will be rejected. Wait for the user to resume with /ferment resume.`;
}

/**
 * Build the planning supplement for draft/planned status.
 */
function buildPlanningSupplement(f: Ferment): string {
	const s = f.scoping;
	const missing: string[] = [];
	if (!s.goal) missing.push("goal");
	if (!s.criteria) missing.push("success criteria");
	if (!s.constraints) missing.push("constraints");
	if (!s.phases) missing.push("phase breakdown");

	if (f.status === "draft") {
		if (missing.length > 0) {
			return `## Ferment Planning

Ferment "${f.name}" is in draft status. Missing: ${missing.join(", ")}.
Call \`ferment_scope\` NOW with goal, successCriteria, constraints, and phases (each with name, goal, and steps). Do not explain — just call it.`;
		}
		return `## Ferment Planning

Ferment "${f.name}" is ready for scoping. Call \`ferment_scope\` to define the plan.`;
	}

	// status === "planned"
	return `## Ferment Ready

Ferment "${f.name}" has been scoped with ${f.phases.length} phase(s).
Call \`ferment_activate_phase\` with phaseId "${f.phases[0]?.id}" to begin.`;
}

function getCurrentPhaseName(f: Ferment): string {
	if (!f.activePhaseId) return "none";
	const phase = f.phases.find(p => p.id === f.activePhaseId);
	return phase?.name ?? "none";
}

function buildFermentPromptBlock(): string {
	const f = getActive();
	if (!f) return IDLE_FERMENT_HINT;

	switch (f.status) {
		case "draft":
			return buildPlanningSupplement(f);
		case "planned":
			return buildPlanningSupplement(f);
		case "running": {
			const action = whatNext(f);
			const header = `## Active Ferment: ${f.name}\nStatus: ${f.status}\nPhase: ${getCurrentPhaseName(f)}\nProgress: ${buildScopingSummary(f)}\nNext Action: ${action?.kind ?? "none"}`;
			return `${header}\n\n${buildPlannerRole(f)}`;
		}
		case "paused":
			return buildPausedWarning(f);
		case "complete":
		case "abandoned":
			return "";
	}
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
