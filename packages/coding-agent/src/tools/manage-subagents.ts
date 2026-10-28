/**
 * ManageSubagentsTool — Ported from Google Antigravity (agy).
 *
 * Supervisor tool to oversee, inspect, and terminate child subagents:
 * - list: reports all active and registered subagents
 * - kill: terminates specific subagent conversation IDs
 * - kill_all: terminates all active subagents and clears child processes
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { AgentRegistry } from "../registry/agent-registry";
import {
	type BuiltinSubagentDefinition,
	getBuiltinSubagentDefinition,
	listBuiltinSubagents,
} from "../registry/builtin-subagents";

export type { BuiltinSubagentDefinition };
export { getBuiltinSubagentDefinition, listBuiltinSubagents };

const manageSubagentsSchema = z.object({
	Action: z
		.enum(["list", "kill", "kill_all"])
		.describe(
			"Action to perform: 'list' reports subagents; 'kill' terminates ConversationIds; 'kill_all' terminates all.",
		),
	ConversationIds: z.array(z.string()).optional().describe("Subagent IDs to kill. Required for 'kill' action."),
});

export type ManageSubagentsParams = z.infer<typeof manageSubagentsSchema>;

export class ManageSubagentsTool implements AgentTool<typeof manageSubagentsSchema> {
	readonly name = "manage_subagents";
	readonly approval = "read" as const;
	readonly label = "Manage Subagents";
	readonly description =
		"Manage the direct subagents of this conversation. 'list' reports each one's conversationId and live state. Killing a subagent terminates it and cleans up its workspace.";
	readonly parameters = manageSubagentsSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Subagent supervisor tool ported from agy (list, kill, kill_all)";

	async execute(
		_toolCallId: string,
		params: ManageSubagentsParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const registry = AgentRegistry.global();

		switch (params.Action) {
			case "list": {
				const allAgents = registry.list();
				const subagents = allAgents.filter(a => a.kind === "sub");
				const builtinSubagents = listBuiltinSubagents();

				if (subagents.length === 0) {
					return {
						content: [{ type: "text", text: "### Active Subagents\nNo subagents currently registered." }],
						details: { subagents: [], builtinSubagents },
					};
				}

				const lines = [
					"### Registered Subagents",
					"| Conversation ID | Role / Name | Status | Created |",
					"| :--- | :--- | :--- | :--- |",
				];

				for (const agent of subagents) {
					const createdStr = new Date(agent.createdAt).toLocaleTimeString();
					lines.push(`| **${agent.id}** | ${agent.displayName} | \`${agent.status}\` | ${createdStr} |`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { subagents, builtinSubagents },
				};
			}

			case "kill": {
				if (!params.ConversationIds || params.ConversationIds.length === 0) {
					return {
						content: [{ type: "text", text: "ConversationIds is required for 'kill' action." }],
					};
				}

				const killed: string[] = [];
				const notFound: string[] = [];

				for (const id of params.ConversationIds) {
					const agent = registry.get(id);
					if (!agent) {
						notFound.push(id);
						continue;
					}

					try {
						if (agent.session) {
							void agent.session.abort();
						}
						registry.setStatus(agent.id, "aborted");
						killed.push(agent.id);
					} catch {
						notFound.push(id);
					}
				}

				const summary: string[] = [];
				if (killed.length > 0) {
					summary.push(`Killed subagents: ${killed.join(", ")}`);
				}
				if (notFound.length > 0) {
					summary.push(`Not found or already inactive: ${notFound.join(", ")}`);
				}

				return {
					content: [{ type: "text", text: summary.join("\n") }],
					details: { killed, notFound },
				};
			}

			case "kill_all": {
				const allSubagents = registry.list().filter(a => a.kind === "sub");
				let count = 0;

				for (const agent of allSubagents) {
					if (agent.status !== "aborted") {
						try {
							if (agent.session) {
								void agent.session.abort();
							}
							registry.setStatus(agent.id, "aborted");
							count++;
						} catch {}
					}
				}

				return {
					content: [
						{
							type: "text",
							text:
								count > 0 ? `Terminated all ${count} active subagents.` : "No active subagents were running.",
						},
					],
					details: { terminatedCount: count },
				};
			}
		}
	}
}
