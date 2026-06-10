/**
 * Ferment lifecycle extension tools — scope, pause, resume, complete, abandon.
 * These wrap the state-machine + FermentStore for LLM-callable use via the ExtensionAPI.
 */

import type { ExtensionAPI } from "@aryee337/aery";
import type { AgentToolResult } from "@aryee337/aery-core";
import { whatNext } from "../../engine.js";
import { applyTransition } from "../../state-machine.js";
import { FermentStore } from "../../store.js";
import type { Ferment, FermentCommand, ScopePhaseInput } from "../../types.js";
import { clearProgressWidget } from "../progress-overlay.js";
import { clearActive, getActive, setActive } from "../state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function success(content: string): AgentToolResult {
	return { content: [{ type: "text", text: content }] };
}

function error(content: string): AgentToolResult {
	return { content: [{ type: "text", text: content }], isError: true };
}

function requireActive(ferment: Ferment | undefined): Ferment {
	if (!ferment) throw new Error("No active ferment. Use ferment_scope first.");
	return ferment;
}

/** Format the next-action hint so the agent always knows what to call next. */
function hintNext(f: Ferment): string {
	const action = whatNext(f);
	if (!action) return "";
	return `\n→ Next action: ${action.kind} — ${action.message}`;
}

/** List phase and step IDs so the agent never has to guess them. */
function listPhases(f: Ferment): string {
	if (f.phases.length === 0) return "No phases defined yet.";
	return f.phases
		.map(p => {
			const steps = p.steps.length > 0 ? ` → steps: [${p.steps.map(s => `"${s.id}"`).join(", ")}]` : "";
			return `  phase "${p.id}" (${p.name}) [${p.status}]${steps}`;
		})
		.join("\n");
}

/** Build a recovery hint from a state-machine error. */
function recoveryHint(err: string): string {
	if (err.includes("No active ferment")) return "\n💡 Call request_ferment_workflow first to create a ferment.";
	if (err.includes("already active")) return "\n💡 A ferment is already active. Complete or abandon it first.";
	if (err.includes("not found"))
		return "\n💡 Check the phaseId/stepId — call the previous tool and use the IDs from its response.";
	return "";
}

/** Enhanced error response with recovery guidance. */
function errorWithRecovery(msg: string): AgentToolResult {
	return error(msg + recoveryHint(msg));
}

/** Enhanced success response with next-action hint. */
function successWithHint(content: string, f: Ferment): AgentToolResult {
	return success(content + hintNext(f));
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerLifecycleTools(api: ExtensionAPI): void {
	const { z } = api.zod;

	// ── ferment_scope ─────────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_scope",
		label: "Ferment Scope",
		description:
			"Define the goal, success criteria, constraints, and phase breakdown for the active ferment. " +
			"Call this after request_ferment_workflow to plan the work.",
		parameters: z.object({
			goal: z.string().describe("Primary goal of this ferment phase/work"),
			title: z.string().optional().describe("Optional ferment title override"),
			successCriteria: z.string().optional().describe("What constitutes done (one line per criterion)"),
			constraints: z.string().optional().describe("Known constraints or non-negotiables"),
			phases: z
				.array(
					z.object({
						name: z.string().describe("Phase name"),
						goal: z.string().describe("What this phase must accomplish"),
						description: z.string().optional().describe("Phase description"),
						constraints: z.array(z.string()).optional().describe("Phase-specific constraints"),
						budget: z.string().optional().describe("Time/budget estimate, e.g. '2h'"),
						parallel_group: z.number().optional().describe("Phases in the same group run in parallel"),
						steps: z
							.array(
								z.object({
									description: z.string().describe("Step description"),
									verify: z.string().optional().describe("Verification command"),
									parallel_group: z.number().optional(),
								}),
							)
							.optional(),
					}),
				)
				.min(1)
				.describe("Phase breakdown (at least one phase required)"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());

				// Normalise success criteria from multi-line string to string[]
				const criteria: string[] | undefined = params.successCriteria
					? params.successCriteria
							.split(/\r?\n/)
							.map(s => s.replace(/^[-*]\s+/, "").trim())
							.filter(Boolean)
					: undefined;

				const constraints: string[] | undefined = params.constraints
					? params.constraints
							.split(/\r?\n/)
							.map(s => s.replace(/^[-*]\s+/, "").trim())
							.filter(Boolean)
					: undefined;

				const cmd: Extract<FermentCommand, { type: "scope" }> = {
					type: "scope",
					goal: params.goal,
					title: params.title,
					successCriteria: criteria,
					constraints,
					phases: params.phases as ScopePhaseInput[],
				};

				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				return successWithHint(
					`Ferment "${result.name}" scoped with ${result.phases.length} phase(s). Status: ${result.status}.\n\nPhases:\n${listPhases(result)}`,
					result,
				);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_pause ─────────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_pause",
		label: "Ferment Pause",
		description: "Pause the active ferment, saving session state.",
		parameters: z.object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const result = applyTransition(ferment, { type: "pause" });
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return success(`Ferment "${result.name}" paused. Resume with /ferment resume.`);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_resume ────────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_resume",
		label: "Ferment Resume",
		description: "Resume a paused ferment.",
		parameters: z.object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const result = applyTransition(ferment, { type: "resume" });
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return successWithHint(`Ferment "${result.name}" resumed. Status: ${result.status}.`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_complete_ferment ──────────────────────────────────────────────
	api.registerTool({
		name: "ferment_complete_ferment",
		label: "Ferment Complete",
		description: "Mark the active ferment as complete.",
		parameters: z.object({
			finalSummary: z.string().optional().describe("Overall ferment summary"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const cmd: Extract<FermentCommand, { type: "complete_ferment" }> = {
					type: "complete_ferment",
					finalSummary: params.finalSummary,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				clearActive();
				// Immediately clear widget and footer so UI updates this turn
				if (_ctx?.ui) {
					clearProgressWidget(_ctx.ui);
					_ctx.ui.setStatus("ferment", undefined);
				}
				return success(`Ferment "${result.name}" marked complete. 🎉`);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_abandon ───────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_abandon",
		label: "Ferment Abandon",
		description: "Abandon the active ferment. Only use when the ferment cannot proceed.",
		parameters: z.object({
			reason: z.string().optional().describe("Reason for abandoning"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const cmd: Extract<FermentCommand, { type: "abandon" }> = {
					type: "abandon",
					reason: params.reason,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				clearActive();
				// Immediately clear widget and footer so UI updates this turn
				if (_ctx?.ui) {
					clearProgressWidget(_ctx.ui);
					_ctx.ui.setStatus("ferment", undefined);
				}
				return success(`Ferment "${result.name}" abandoned. Start a new workflow with request_ferment_workflow.`);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_new ───────────────────────────────────────────────────────────
	// DEPRECATED: Agents should use request_ferment_workflow instead, which
	// creates the ferment AND asks the user for confirmation.
	api.registerTool({
		name: "ferment_new",
		label: "Ferment New (deprecated)",
		description:
			"⚠️ DEPRECATED — use request_ferment_workflow instead, which creates the ferment and asks the user for confirmation. " +
			"This tool bypasses user confirmation and should only be used by automation or when request_ferment_workflow is unavailable.",
		parameters: z.object({
			goal: z.string().describe("What the ferment should accomplish"),
			title: z.string().optional().describe("Optional title"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			// Refuse if a ferment is already active
			if (getActive()) {
				return error("ferment_new refused — a ferment is already active. Complete or abandon it first.");
			}
			const now = new Date().toISOString();
			const draft: Ferment = {
				id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				name: params.title ?? params.goal.slice(0, 60),
				status: "draft",
				goal: params.goal,
				worktree: { path: process.cwd() },
				scoping: {},
				phases: [],
				decisions: [],
				memories: [],
				createdAt: now,
				updatedAt: now,
			};
			setActive(draft);
			FermentStore.open().save(draft);
			return success(
				`⚠️ DEPRECATED: Use request_ferment_workflow next time.\n` +
					`Draft ferment "${draft.name}" created. Use ferment_scope to plan phases.`,
			);
		},
	});
	// ── request_ferment_workflow ──────────────────────────────────────────────
	// The primary way the agent initiates a ferment. Asks the user for
	// confirmation before creating, like Aery's request_ferment_workflow.
	api.registerTool({
		name: "request_ferment_workflow",
		label: "Request Ferment Workflow",
		description:
			"Request the ferment workflow for substantive multi-step work. Provide a concise title and the full original user intent. The host asks the user for confirmation before creating the draft. Refuses if another ferment is already active. This is the ONLY recommended way to start a ferment.",
		parameters: z.object({
			title: z.string().describe("Concise 3-5 word title for the ferment (e.g. 'Rewrite login flow')."),
			intent: z.string().describe("Full original user request, preserving all constraints and scope details."),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const title = params.title.trim();
			if (!title) return error('Field "title" must be a non-empty string.');
			const intent = params.intent.trim();
			if (!intent) return error('Field "intent" must be the full non-empty user request.');

			// Refuse if a ferment is already active
			if (getActive()) {
				return error(
					"request_ferment_workflow refused — another ferment is already active. Continue that ferment or ask the user before starting a separate workflow.",
				);
			}

			// Ask the user for confirmation
			let approved = true;
			if (_ctx?.ui?.confirm) {
				try {
					approved = await _ctx.ui.confirm(
						"Start Ferment Workflow",
						`Start a Ferment workflow for "${title}"?\n\n${intent}`,
					);
				} catch {
					// confirm not available — assume approved
				}
			}

			if (!approved) {
				return error(
					"request_ferment_workflow cancelled — the user declined. Continue inline or ask only decision-blocking clarification.",
				);
			}

			// Create the ferment
			const now = new Date().toISOString();
			const ferment: Ferment = {
				id: `ferment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				name: title !== intent ? title : intent.slice(0, 40),
				status: "draft",
				goal: intent,
				worktree: { path: process.cwd() },
				scoping: {
					goal: { answer: intent, confirmedAt: now },
				},
				phases: [],
				decisions: [],
				memories: [],
				createdAt: now,
				updatedAt: now,
			};
			FermentStore.open().save(ferment);
			setActive(ferment);
			return success(`Ferment "${ferment.name}" created. Follow the scoping instructions the host will inject.`);
		},
	});

	// ── update_ferment_scope_field ────────────────────────────────────────────
	api.registerTool({
		name: "update_ferment_scope_field",
		label: "Update Ferment Scope Field",
		description:
			"Update a single scoping field (goal, criteria, or constraints) on the active ferment. " +
			"The ferment must be in 'draft' or 'planned' status.",
		parameters: z.object({
			field: z.enum(["goal", "criteria", "constraints"]).describe("The scoping field to update"),
			value: z.string().describe("The new value for the field"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const cmd: Extract<FermentCommand, { type: "update_scope_field" }> = {
					type: "update_scope_field",
					field: params.field,
					value: params.value,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);

				return successWithHint(`Updated "${params.field}" on ferment "${result.name}".`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_rename ────────────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_rename",
		label: "Ferment Rename",
		description: "Rename the active ferment.",
		parameters: z.object({
			name: z.string().min(1).describe("New name for the ferment"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const cmd: Extract<FermentCommand, { type: "rename" }> = {
					type: "rename",
					name: params.name,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return successWithHint(`Ferment renamed to "${result.name}".`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_set_phase_grade ───────────────────────────────────────────────
	api.registerTool({
		name: "ferment_set_phase_grade",
		label: "Ferment Set Phase Grade",
		description: "Set a grade on a phase (A–F).",
		parameters: z.object({
			phaseId: z.string().describe("Phase ID or name"),
			grade: z.enum(["A", "B", "C", "D", "F"]).describe("Grade to assign"),
			rationale: z.string().optional().describe("Optional rationale for the grade"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				// Use resolvePhaseId-style lookup inline
				const phase =
					ferment.phases.find(p => p.id === params.phaseId) ??
					ferment.phases.find(p => p.name.toLowerCase() === params.phaseId.toLowerCase());
				if (!phase) return errorWithRecovery(`Phase "${params.phaseId}" not found.`);
				const cmd: Extract<FermentCommand, { type: "set_phase_grade" }> = {
					type: "set_phase_grade",
					phaseId: phase.id,
					grade: {
						grade: params.grade as any,
						rationale: params.rationale ?? "",
						gradedAt: new Date().toISOString(),
					},
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return successWithHint(`Phase "${phase.name}" graded ${params.grade}.`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_set_step_grade ────────────────────────────────────────────────
	api.registerTool({
		name: "ferment_set_step_grade",
		label: "Ferment Set Step Grade",
		description: "Set a grade on a step (A–F).",
		parameters: z.object({
			phaseId: z.string().describe("Phase ID or name"),
			stepId: z.string().describe("Step ID or description prefix"),
			grade: z.enum(["A", "B", "C", "D", "F"]).describe("Grade to assign"),
			rationale: z.string().optional().describe("Optional rationale for the grade"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				// Resolve phase
				const phase =
					ferment.phases.find(p => p.id === params.phaseId) ??
					ferment.phases.find(p => p.name.toLowerCase() === params.phaseId.toLowerCase());
				if (!phase) return errorWithRecovery(`Phase "${params.phaseId}" not found.`);
				// Resolve step by ID or description prefix
				const step =
					phase.steps.find(s => s.id === params.stepId) ??
					phase.steps.find(s => s.description.toLowerCase().startsWith(params.stepId.toLowerCase()));
				if (!step) return errorWithRecovery(`Step "${params.stepId}" not found in phase "${phase.name}".`);
				const cmd: Extract<FermentCommand, { type: "set_step_grade" }> = {
					type: "set_step_grade",
					phaseId: phase.id,
					stepId: step.id,
					grade: {
						grade: params.grade as any,
						rationale: params.rationale ?? "",
						gradedAt: new Date().toISOString(),
					},
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return successWithHint(`Step "${step.description}" graded ${params.grade}.`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_set_ferment_grade ─────────────────────────────────────────────
	api.registerTool({
		name: "ferment_set_ferment_grade",
		label: "Ferment Set Ferment Grade",
		description: "Set a grade on the entire ferment (A–F).",
		parameters: z.object({
			grade: z.enum(["A", "B", "C", "D", "F"]).describe("Grade to assign"),
			rationale: z.string().optional().describe("Optional rationale for the grade"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				const cmd: Extract<FermentCommand, { type: "set_ferment_grade" }> = {
					type: "set_ferment_grade",
					grade: {
						grade: params.grade as any,
						rationale: params.rationale ?? "",
						gradedAt: new Date().toISOString(),
					},
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return successWithHint(`Ferment "${result.name}" graded ${params.grade}.`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});

	// ── ferment_update_step_description ───────────────────────────────────────
	api.registerTool({
		name: "ferment_update_step_description",
		label: "Ferment Update Step Description",
		description: "Update the description of a step in the active ferment.",
		parameters: z.object({
			phaseId: z.string().describe("Phase ID or name"),
			stepId: z.string().describe("Step ID or description prefix"),
			description: z.string().min(1).describe("New description for the step"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const ferment = requireActive(getActive());
				// Resolve phase
				const phase =
					ferment.phases.find(p => p.id === params.phaseId) ??
					ferment.phases.find(p => p.name.toLowerCase() === params.phaseId.toLowerCase());
				if (!phase) return errorWithRecovery(`Phase "${params.phaseId}" not found.`);
				// Resolve step by ID or description prefix
				const step =
					phase.steps.find(s => s.id === params.stepId) ??
					phase.steps.find(s => s.description.toLowerCase().startsWith(params.stepId.toLowerCase()));
				if (!step) return errorWithRecovery(`Step "${params.stepId}" not found in phase "${phase.name}".`);
				const cmd: Extract<FermentCommand, { type: "update_step_description" }> = {
					type: "update_step_description",
					phaseId: phase.id,
					stepId: step.id,
					description: params.description,
				};
				const result = applyTransition(ferment, cmd);
				if ("error" in result) return errorWithRecovery(result.error);

				FermentStore.open().save(result);
				setActive(result);
				return successWithHint(`Step "${step.description}" updated to "${params.description}".`, result);
			} catch (err) {
				return errorWithRecovery(String(err));
			}
		},
	});
}
