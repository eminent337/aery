/**
 * Continual Harness Engine
 * 
 * Ported from Prime-Agent's refinement.ts to support persistent,
 * editable harness state for prompts, memories, skills, and subagents.
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@aryee337/aery-ai";
import { completeSimple } from "@aryee337/aery-ai";
import { countTokens } from "@aryee337/aery-engine";
import type { HarnessHost, HarnessState, RefinementEdit, RefinementProposal, RefinementResult, RefineOptions } from "./types.js";
import {
	appendGlobalRefinement,
	 loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	saveHarnessState,
} from "./state.js";

const REFINEMENT_SYSTEM_PROMPT = `You are Aery's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets Aery improve reusable behavior
outside the token history.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: reusable code or procedure. Skill create/update edits MUST include a \`reference\` object with \`{"type":"typescript"}\`, a TypeScript import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the TypeScript callable truly needs no external inputs. Include the native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the native call form: compose a concise task prompt and spawn with \`handle = await rlm("sub-task")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current Aery session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as TypeScript calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "typescript", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are Aery's automatic /refine review gate.

Analyze whether the current trajectory warrants a refinement pass.
Consider:
- Are there repeated patterns or lessons learned?
- Is there valuable context that should persist beyond this session?
- Are there skills or workflows that would benefit from automation?

Output JSON:
{
  "shouldRefine": true/false,
  "rationale": "why or why not",
  "instructions": "optional focus for the refinement"
}`;

const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

export class ContinualHarnessEngine {
	readonly #host: HarnessHost;

	constructor(host: HarnessHost) {
		this.#host = host;
	}

	/**
	 * Run a manual refinement.
	 */
	async refine(
		model: Model,
		apiKey: string,
		options: RefineOptions = {},
	): Promise<RefinementResult> {
		const state = await this.#host.getHarnessState();
		const history = await this.#host.getRefinementHistory();
		const trajectory = await this.#host.getTrajectory();

		const proposal = await this.#planRefinement(
			state,
			history,
			trajectory,
			model,
			apiKey,
			options,
		);

		return this.#applyProposal(state, proposal, options);
	}

	/**
	 * Review whether auto-refine should trigger.
	 */
	async reviewAutoRefine(
		model: Model,
		apiKey: string,
		context: { reason: "turn_interval" | "compact"; turnsSinceLastReview: number },
	): Promise<{ shouldRefine: boolean; rationale: string; instructions?: string }> {
		const state = await this.#host.getHarnessState();
		const history = await this.#host.getRefinementHistory();
		const trajectory = await this.#host.getTrajectory();

		const review = await this.#reviewAutoRefine(
			state,
			history,
			trajectory,
			model,
			apiKey,
			context,
		);

		return {
			shouldRefine: review.shouldRefine,
			rationale: review.rationale,
			instructions: review.instructions,
		};
	}

	/**
	 * Rollback a previous refinement.
	 */
	async rollback(resultId: string): Promise<RefinementResult | null> {
		const state = await this.#host.getHarnessState();
		const history = await this.#host.getRefinementHistory();
		
		const target = history.find(r => r.id === resultId);
		if (!target) return null;

		// Create rollback proposal
		const rollbackProposal = this.#createRollbackProposal(target);
		
		return this.#applyProposal(state, rollbackProposal, {
			rollbackId: resultId,
			global: target.scope === "global",
		});
	}

	/**
	 * Plan a refinement proposal via LLM.
	 */
	async #planRefinement(
		state: HarnessState,
		history: RefinementResult[],
		trajectory: string,
		model: Model,
		apiKey: string,
		options: RefineOptions,
	): Promise<RefinementProposal> {
		const stateOverview = this.#formatStateForPrompt(state);
		const historyOverview = this.#formatHistoryForPrompt(history);
		
		const userPrompt = [
			`<trajectory>\n${trajectory.slice(-40_000)}\n</trajectory>`,
			`<current_harness_state>\n${stateOverview}\n</current_harness_state>`,
			`<refinement_history>\n${historyOverview}\n</refinement_history>`,
			options.instructions ? `<instructions>\n${options.instructions}\n</instructions>` : "",
		].filter(Boolean).join("\n\n");

		const response = await completeSimple({
			messages: [
				{ role: "system", content: REFINEMENT_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			model,
			maxTokens: Math.min(model.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS),
			apiKey,
		});

		if (response.stopReason === "error") {
			throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
		}
		if (response.stopReason === "length") {
			throw new Error(TRUNCATED_JSON_ERROR);
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");

		return this.#parseProposal(text);
	}

	/**
	 * Review whether auto-refine should trigger.
	 */
	async #reviewAutoRefine(
		state: HarnessState,
		history: RefinementResult[],
		trajectory: string,
		model: Model,
		apiKey: string,
		context: { reason: "turn_interval" | "compact"; turnsSinceLastReview: number },
	): Promise<{ shouldRefine: boolean; rationale: string; instructions?: string }> {
		const userPrompt = [
			`<trigger>\n${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review\n</trigger>`,
			`<current_harness_state>\n${this.#formatStateForPrompt(state)}\n</current_harness_state>`,
		].join("\n\n");

		const response = await completeSimple({
			messages: [
				{ role: "system", content: AUTO_REFINE_REVIEW_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			model,
			maxTokens: Math.min(model.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS),
			apiKey,
		});

		if (response.stopReason === "error") {
			throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");

		return this.#parseAutoRefineReview(text);
	}

	/**
	 * Apply a refinement proposal.
	 */
	async #applyProposal(
		state: HarnessState,
		proposal: RefinementProposal,
		options: RefineOptions,
	): Promise<RefinementResult> {
		const appliedEdits = await this.#applyEdits(state, proposal.edits, options);
		
		const result: RefinementResult = {
			id: randomUUID(),
			summary: proposal.summary,
			rationale: proposal.rationale,
			expectedOutcome: proposal.expectedOutcome,
			appliedEdits,
			harnessStatePath: "",
			rollbackOf: options.rollbackId,
			scope: options.global ? "global" : "local",
		};

		// Save updated state
		const newState = this.#applyEditsToState(state, appliedEdits);
		await this.#host.saveHarnessState(newState);
		result.harnessStatePath = await this.#saveState(newState);

		// Append to history
		await this.#host.appendRefinementHistory(result);

		return result;
	}

	/**
	 * Apply edits to state and track before/after.
	 */
	async #applyEdits(
		state: HarnessState,
		edits: RefinementEdit[],
		options: RefineOptions,
	): Promise<import("./types.js").AppliedRefinementEdit[]> {
		return Promise.all(edits.map(async edit => {
			try {
				const before = this.#getEntry(state, edit.kind, edit.id);
				const after = this.#applySingleEdit(state, edit);
				return {
					...edit,
					id: edit.id || randomUUID(),
					before,
					after,
					applied: true,
				};
			} catch (error) {
				return {
					...edit,
					id: edit.id || randomUUID(),
					applied: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		}));
	}

	/**
	 * Apply a single edit to state.
	 */
	#applySingleEdit(state: HarnessState, edit: RefinementEdit): HarnessState {
		const newState = { ...state };
		const kindState = { ...newState.entries[edit.kind] };
		
		switch (edit.action) {
			case "create":
				if (!edit.title || !edit.content) {
					throw new Error("Create requires title and content");
				}
				kindState[edit.id || randomUUID()] = {
					id: edit.id || randomUUID(),
					kind: edit.kind,
					title: edit.title,
					content: edit.content,
					path: edit.path || "",
					scope: edit.metadata?.scope as "local" | "global" || "local",
					reference: edit.reference || {},
					arguments: edit.arguments || {},
					metadata: edit.metadata || {},
					source: edit.reason || "manual",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					version: 1,
				};
				break;
			case "update":
				if (!edit.id) {
					throw new Error("Update requires id");
				}
				const existing = kindState[edit.id];
				if (!existing) {
					throw new Error(`Entry ${edit.id} not found`);
				}
				kindState[edit.id] = {
					...existing,
					title: edit.title || existing.title,
					content: edit.content || existing.content,
					path: edit.path || existing.path,
					reference: edit.reference || existing.reference,
					arguments: edit.arguments || existing.arguments,
					metadata: { ...existing.metadata, ...edit.metadata },
					updated_at: new Date().toISOString(),
					version: existing.version + 1,
				};
				break;
			case "delete":
				if (!edit.id) {
					throw new Error("Delete requires id");
				}
				delete kindState[edit.id];
				break;
		}
		
		newState.entries = {
			...newState.entries,
			[edit.kind]: kindState,
		};
		
		return newState;
	}

	/**
	 * Apply edits to state and return new state.
	 */
	#applyEditsToState(state: HarnessState, edits: import("./types.js").AppliedRefinementEdit[]): HarnessState {
		let result = state;
		for (const edit of edits) {
			if (edit.applied) {
				result = this.#applySingleEdit(result, edit);
			}
		}
		return result;
	}

	/**
	 * Format harness state for prompt.
	 */
	#formatStateForPrompt(state: HarnessState): string {
		const lines: string[] = [];
		
		for (const kind of ["prompt", "memory", "skill", "subagent"] as const) {
			const entries = Object.values(state.entries[kind]);
			if (entries.length === 0) continue;
			
			lines.push(`## ${kind.toUpperCase()} Entries (${entries.length})`);
			
			for (const entry of entries.slice(0, 6)) {
				lines.push(`- ${entry.id}: ${entry.title}`);
				if (entry.content.length > 180) {
					lines.push(`  ${entry.content.slice(0, 180)}...`);
				} else {
					lines.push(`  ${entry.content}`);
				}
			}
			
			if (entries.length > 6) {
				lines.push(`  ... and ${entries.length - 6} more`);
			}
			lines.push("");
		}
		
		return lines.join("\n") || "No entries yet.";
	}

	/**
	 * Format history for prompt.
	 */
	#formatHistoryForPrompt(history: RefinementResult[]): string {
		if (history.length === 0) return "No refinement history.";
		
		const lines = history.slice(-5).map(r => {
			const changes = r.appliedEdits
				.filter(e => e.applied)
				.map(e => `${e.action} ${e.kind}: ${e.id || e.title}`)
				.join(", ");
			return `- ${r.summary}: ${changes}`;
		});
		
		return lines.join("\n");
	}

	/**
	 * Parse LLM proposal.
	 */
	#parseProposal(text: string): RefinementProposal {
		try {
			const json = this.#extractJsonObject(text);
			if (!json || typeof json !== "object") {
				throw new Error("Invalid proposal format");
			}
			
			const proposal = json as Record<string, unknown>;
			
			return {
				summary: typeof proposal.summary === "string" ? proposal.summary : "",
				rationale: typeof proposal.rationale === "string" ? proposal.rationale : "",
				expectedOutcome: typeof proposal.expectedOutcome === "string" ? proposal.expectedOutcome : "",
				edits: Array.isArray(proposal.edits)
					? proposal.edits.map((e: unknown) => this.#parseEdit(e)).filter(Boolean)
					: [],
			};
		} catch {
			throw new Error("Failed to parse refinement proposal");
		}
	}

	/**
	 * Parse a single edit.
	 */
	#parseEdit(raw: unknown): RefinementEdit | undefined {
		if (typeof raw !== "object" || raw === null) return undefined;
		
		const edit = raw as Record<string, unknown>;
		
		if (typeof edit.action !== "string" || typeof edit.kind !== "string") {
			return undefined;
		}
		
		return {
			action: edit.action as RefinementEdit["action"],
			kind: edit.kind as RefinementEdit["kind"],
			id: typeof edit.id === "string" ? edit.id : undefined,
			title: typeof edit.title === "string" ? edit.title : undefined,
			content: typeof edit.content === "string" ? edit.content : undefined,
			path: typeof edit.path === "string" ? edit.path : undefined,
			reference: typeof edit.reference === "object" && edit.reference !== null ? edit.reference as Record<string, unknown> : undefined,
			arguments: typeof edit.arguments === "object" && edit.arguments !== null ? edit.arguments as Record<string, unknown> : undefined,
			metadata: typeof edit.metadata === "object" && edit.metadata !== null ? edit.metadata as Record<string, unknown> : undefined,
			reason: typeof edit.reason === "string" ? edit.reason : undefined,
		};
	}

	/**
	 * Parse auto-refine review.
	 */
	#parseAutoRefineReview(text: string): { shouldRefine: boolean; rationale: string; instructions?: string } {
		try {
			const json = this.#extractJsonObject(text);
			if (!json || typeof json !== "object") {
				throw new Error("Invalid review format");
			}
			
			const review = json as Record<string, unknown>;
			
			return {
				shouldRefine: review.shouldRefine === true,
				rationale: typeof review.rationale === "string" ? review.rationale : "No rationale provided.",
				instructions: typeof review.instructions === "string" ? review.instructions : undefined,
			};
		} catch {
			return {
				shouldRefine: false,
				rationale: "Failed to parse review",
			};
		}
	}

	/**
	 * Extract JSON object from text.
	 */
	#extractJsonObject(text: string): unknown {
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;
		
		try {
			return JSON.parse(jsonMatch[0]);
		} catch {
			return null;
		}
	}

	/**
	 * Get an entry from state.
	 */
	#getEntry(state: HarnessState, kind: string, id: string | undefined): import("./types.js").HarnessEntry | undefined {
		if (!id) return undefined;
		return state.entries[kind as import("./types.js").RefinementKind]?.[id];
	}

	/**
	 * Create a rollback proposal.
	 */
	#createRollbackProposal(target: RefinementResult): RefinementProposal {
		return {
			summary: `Rollback of ${target.summary}`,
			rationale: `Reverting changes from ${target.id}`,
			expectedOutcome: "Restore state before original refinement",
			edits: target.appliedEdits
				.filter(e => e.applied && e.after)
				.map(e => ({
					action: "create" as const,
					kind: e.kind,
					id: e.id,
					title: e.before?.title || e.title,
					content: e.before?.content || e.content || "",
					reason: `Rollback of ${target.id}`,
				})),
		};
	}

	/**
	 * Save state to disk.
	 */
	async #saveState(state: HarnessState): Promise<string> {
		// This would be implemented based on Aery's storage system
		return "/tmp/harness_state.json";
	}
}

/**
 * Create a continual harness engine instance.
 */
export function createContinualHarnessEngine(host: HarnessHost): ContinualHarnessEngine {
	return new ContinualHarnessEngine(host);
}
