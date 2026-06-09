/**
 * Ferment knowledge tools — record decisions and memories for the active ferment.
 */

import type { ExtensionAPI } from "@aryee337/aery";
import type { AgentToolResult } from "@aryee337/aery-core";
import { FermentStore } from "../../store.js";
import type { Decision, Ferment, Memory } from "../../types.js";
import { getActive, setActive } from "../state.js";

function success(content: string): AgentToolResult {
	return { content: [{ type: "text", text: content }] };
}

function error(content: string): AgentToolResult {
	return { content: [{ type: "text", text: content }], isError: true };
}

function requireActive(ferment: Ferment | undefined): Ferment {
	if (!ferment) throw new Error("No active ferment.");
	return ferment;
}

function nextDecisionId(decisions: Decision[]): string {
	const n = decisions.length + 1;
	return `D${String(n).padStart(3, "0")}`;
}

function nextMemoryId(memories: Memory[]): string {
	const n = memories.length + 1;
	return `M${String(n).padStart(3, "0")}`;
}

export function registerKnowledgeTools(api: ExtensionAPI): void {
	const { z } = api.zod;

	api.registerTool({
		name: "ferment_add_decision",
		label: "Add Decision",
		description: "Record an architectural or design decision for the active ferment.",
		parameters: z.object({
			title: z.string().describe("Short decision title"),
			description: z.string().describe("Detailed rationale"),
			phaseId: z.string().optional().describe("Optional related phase ID"),
			stepId: z.string().optional().describe("Optional related step ID"),
		}),
		async execute(_id, params) {
			try {
				const ferment = requireActive(getActive());
				const decision: Decision = {
					id: nextDecisionId(ferment.decisions),
					title: params.title,
					description: params.description,
					phaseId: params.phaseId,
					stepId: params.stepId,
					createdAt: new Date().toISOString(),
				};
				ferment.decisions.push(decision);
				FermentStore.open().save(ferment as Ferment & Record<string, unknown>);
				setActive(ferment);
				return success(`Decision ${decision.id} recorded: ${params.title}`);
			} catch (e) {
				return error(e instanceof Error ? e.message : String(e));
			}
		},
	});

	api.registerTool({
		name: "ferment_add_memory",
		label: "Add Memory",
		description: "Record a pattern, convention, gotcha, architecture note, or preference for the active ferment.",
		parameters: z.object({
			category: z
				.enum(["architecture", "convention", "gotcha", "pattern", "preference"])
				.describe("Memory category"),
			content: z.string().describe("The knowledge to record"),
			phaseId: z.string().optional(),
			stepId: z.string().optional(),
		}),
		async execute(_id, params) {
			try {
				const ferment = requireActive(getActive());
				const memory: Memory = {
					id: nextMemoryId(ferment.memories),
					category: params.category,
					content: params.content,
					phaseId: params.phaseId,
					stepId: params.stepId,
					createdAt: new Date().toISOString(),
				};
				ferment.memories.push(memory);
				FermentStore.open().save(ferment as Ferment & Record<string, unknown>);
				setActive(ferment);
				return success(`Memory ${memory.id} recorded: ${params.content.slice(0, 80)}`);
			} catch (e) {
				return error(e instanceof Error ? e.message : String(e));
			}
		},
	});
}
