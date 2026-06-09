/**
 * invoke_subagent tool — non-blocking background subagent delegation.
 *
 * Registers each subagent as an AsyncJob so results flow through the
 * YieldQueue → async-result injection path. The agent sees completion
 * notifications as system-notice messages on its next turn, just like
 * the `task` tool's background mode.
 *
 * Falls back to synchronous execution when the AsyncJobManager is not
 * available (async.enabled is not set).
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { logger } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import { AsyncJobManager } from "../async/job-manager";
import { discoverAgents, getAgent } from "../task/discovery";
import { runSubprocess } from "../task/executor";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from ".";

const invokeSubagentSchema = z.object({
	Subagents: z
		.array(
			z.object({
				Prompt: z.string().describe("A clear, actionable task description for the subagent"),
				Role: z.string().describe("A 2-5 word description of the subagent's role"),
			}),
		)
		.describe("Array of subagents to invoke"),
});

type InvokeSubagentParams = z.infer<typeof invokeSubagentSchema>;

function buildExecutorOptions(
	session: ToolSession,
	agentDef: AgentDefinition,
	prompt: string,
	label: string,
	signal?: AbortSignal,
) {
	return {
		cwd: session.cwd,
		agent: agentDef,
		task: prompt,
		assignment: prompt,
		index: 0,
		id: label,
		taskDepth: (session.taskDepth ?? 0) + 1,
		parentActiveModelPattern: session.getActiveModelString?.(),
		modelOverride: session.getModelString?.(),
		signal,
		eventBus: session.eventBus,
		sessionFile: session.getSessionFile?.(),
		enableLsp: session.enableLsp ?? false,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		mcpManager: session.mcpManager,
		contextFiles: session.contextFiles,
		skills: session.skills,
		promptTemplates: session.promptTemplates,
		workspaceTree: session.workspaceTree,
		localProtocolOptions: session.localProtocolOptions,
	};
}

export class InvokeSubagentTool implements AgentTool<typeof invokeSubagentSchema, { invokedIds: string[] }> {
	readonly name = "invoke_subagent";
	readonly approval = "write" as const;
	readonly label = "Invoke Subagent";
	readonly summary = "Launch background subagents";
	readonly description =
		"Invokes one or more subagents in the background. Each entry defines a separate subagent to launch concurrently. Results are delivered automatically via system-notice when complete. Use `job` to poll or cancel running subagents.";
	readonly parameters = invokeSubagentSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): InvokeSubagentTool | null {
		return new InvokeSubagentTool(session);
	}

	async execute(
		_toolCallId: string,
		params: InvokeSubagentParams,
	): Promise<AgentToolResult<{ invokedIds: string[] }>> {
		const manager = AsyncJobManager.instance();
		const resolvedAgentId = this.session.getAgentId?.() ?? "Main";
		const { agents } = await discoverAgents(this.session.cwd);

		const invokedIds: string[] = [];
		const syncResults: string[] = [];
		const errors: string[] = [];

		for (const subagent of params.Subagents) {
			const roleId = subagent.Role.toLowerCase().replace(/\s+/g, "-").slice(0, 32);
			const label = `subagent:${roleId}`;
			const found = getAgent(agents, subagent.Role) ?? getAgent(agents, roleId) ?? getAgent(agents, "task");

			if (!found) {
				errors.push(`${subagent.Role}: no agent definition found`);
				continue;
			}

			// Strip model from agent definition so the subagent uses the parent's
			// model rather than failing on agent-specific model overrides (e.g. aery/smol).
			const agentDef = { ...found, model: undefined } as const;
			if (manager) {
				try {
					const jobId = manager.register(
						"task",
						label,
						async ({ signal: runSignal, reportProgress }) => {
							await reportProgress(`Running subagent (${subagent.Role})...`);
							const result = await runSubprocess(
								buildExecutorOptions(this.session, agentDef, subagent.Prompt, label, runSignal),
							);
							const text = result.output || "(no output)";
							if ((result.exitCode ?? 0) !== 0) {
								throw new Error(
									`Subagent ${subagent.Role} failed (exit ${result.exitCode}): ${text.slice(0, 500)}`,
								);
							}
							return text;
						},
						{ id: label, ownerId: resolvedAgentId },
					);
					invokedIds.push(jobId);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					errors.push(`${subagent.Role}: ${message}`);
					logger.error("Failed to schedule subagent", { role: subagent.Role, error: message });
				}
			} else {
				try {
					const result = await runSubprocess(buildExecutorOptions(this.session, agentDef, subagent.Prompt, label));
					if ((result.exitCode ?? 0) !== 0) {
						errors.push(
							`${subagent.Role}: exit ${result.exitCode}:\n${(result.output || "(no output)").slice(0, 300)}`,
						);
					} else {
						syncResults.push(`**${subagent.Role}**:\n${(result.output || "(no output)").slice(0, 2000)}`);
						invokedIds.push(label);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					errors.push(`${subagent.Role}: ${message}`);
					logger.error("Failed to run subagent", { role: subagent.Role, error: message });
				}
			}
		}

		if (manager) {
			if (invokedIds.length === 0) {
				return {
					content: [{ type: "text", text: `Failed to start subagents: ${errors.join("; ")}` }],
					details: { invokedIds: [] },
				};
			}
			const failureSummary = errors.length > 0 ? ` Failed to schedule ${errors.length} subagent(s).` : "";
			const startedListing = invokedIds.map(id => `- Job \`${id}\``).join("\n");
			return {
				content: [
					{
						type: "text",
						text: `Started ${invokedIds.length} background subagent${invokedIds.length === 1 ? "" : "s"}${failureSummary}. Results will be delivered automatically when complete.\n${startedListing}\nUse \`job\` to inspect, poll, or cancel running subagents.`,
					},
				],
				details: { invokedIds },
			};
		}

		if (invokedIds.length === 0 && syncResults.length === 0) {
			return {
				content: [
					{ type: "text", text: errors.length > 0 ? `Failed: ${errors.join("; ")}` : "No subagents to invoke." },
				],
				details: { invokedIds: [] },
			};
		}

		const errorText = errors.length > 0 ? `\n\n**Errors:**\n${errors.join("\n")}` : "";
		return {
			content: [
				{
					type: "text",
					text: `Completed ${syncResults.length} subagent${syncResults.length === 1 ? "" : "s"}.${errorText}\n\n${syncResults.join("\n\n")}`,
				},
			],
			details: { invokedIds },
		};
	}
}
