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
	listCustomSubagents,
} from "../registry/builtin-subagents";

export type { BuiltinSubagentDefinition };
export { getBuiltinSubagentDefinition, listBuiltinSubagents, listCustomSubagents };

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
				const customSubagents = listCustomSubagents();

				if (subagents.length === 0) {
					return {
						content: [{ type: "text", text: "### Active Subagents\nNo subagents currently registered." }],
						details: { subagents: [], builtinSubagents, customSubagents },
					};
				}

				const lines = [
					"### Registered Subagents",
					"| Conversation ID | Role / Name | Status | Active Tool | Created |",
					"| :--- | :--- | :--- | :--- | :--- |",
				];

				for (const agent of subagents) {
					const createdStr = new Date(agent.createdAt).toLocaleTimeString();
					const cleanArgs = agent.currentToolArgs
						? agent.currentToolArgs
								.replace(/[\r\n|`]/g, " ")
								.trim()
								.slice(0, 50)
						: "";
					const toolDetails = agent.currentTool
						? `${agent.currentTool}${cleanArgs ? ` (${cleanArgs})` : ""}`
						: "—";
					const cleanName = agent.displayName.replace(/\|/g, "\\|");
					lines.push(
						`| **${agent.id}** | ${cleanName} | \`${agent.status}\` | \`${toolDetails}\` | ${createdStr} |`,
					);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { subagents, builtinSubagents, customSubagents },
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

				await Promise.allSettled(
					params.ConversationIds.map(async id => {
						const agent = registry.get(id);
						if (!agent || agent.status === "aborted") {
							notFound.push(id);
							return;
						}

						try {
							registry.setStatus(agent.id, "aborted");
							registry.setProgress(agent.id, {
								currentTool: undefined,
								currentToolArgs: undefined,
							});
							if (agent.session) {
								try {
									await agent.session.abort();
								} catch {}
								try {
									await agent.session.dispose();
								} catch {}
							}
							registry.detachSession(agent.id);
							killed.push(agent.id);
						} catch {
							notFound.push(id);
						}
					}),
				);

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
				const activeSubagents = registry.list().filter(a => a.kind === "sub" && a.status !== "aborted");
				await Promise.allSettled(
					activeSubagents.map(async agent => {
						try {
							registry.setStatus(agent.id, "aborted");
							registry.setProgress(agent.id, {
								currentTool: undefined,
								currentToolArgs: undefined,
							});
							if (agent.session) {
								try {
									await agent.session.abort();
								} catch {}
								try {
									await agent.session.dispose();
								} catch {}
							}
							registry.detachSession(agent.id);
						} catch {}
					}),
				);

				const count = activeSubagents.length;
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
