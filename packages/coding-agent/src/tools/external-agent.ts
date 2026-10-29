/**
 * CallExternalAgentTool — invoke external AI coding agents installed on the host machine.
 *
 * Supported agents: agy, codex, opencode, claude, aider, pi, gh, custom.
 * Use agent: 'list' to discover which agents are available in PATH.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { detectExternalAgents } from "../extensibility/external-agents/discovery";
import { executeExternalAgent } from "../extensibility/external-agents/runner";

const callExternalAgentSchema = z.object({
	agent: z
		.string()
		.describe(
			"The external agent to invoke: 'agy', 'codex', 'opencode', 'claude', 'aider', 'pi', 'gh', 'custom' — or 'list' to see which agents are installed on this machine.",
		),
	prompt: z
		.string()
		.optional()
		.describe("Task instructions to deliver to the external agent. Required unless agent is 'list'."),
	cwd: z
		.string()
		.optional()
		.describe("Working directory for the agent. Defaults to current workspace."),
	background: z
		.boolean()
		.optional()
		.describe("If true, runs the agent as a background job and returns immediately with a jobId."),
	extraArgs: z
		.array(z.string())
		.optional()
		.describe("Additional CLI flags to append to the agent command."),
	customBinary: z
		.string()
		.optional()
		.describe("Binary path or name. Required when agent is 'custom'."),
	timeoutMs: z
		.number()
		.optional()
		.describe("Timeout in milliseconds (default: 300000 / 5 minutes)."),
});

type CallExternalAgentParams = z.infer<typeof callExternalAgentSchema>;

/** Minimal session interface to avoid circular import from ./index */
interface MinimalSession {
	cwd: string;
}

export class CallExternalAgentTool implements AgentTool<typeof callExternalAgentSchema> {
	readonly name = "call_external_agent";
	readonly approval = "exec" as const;
	readonly label = "External Agent";
	readonly summary = "Call an external AI coding agent installed on this machine";
	readonly description =
		"Execute a task using an external AI coding agent installed on this machine (agy, codex, opencode, claude, aider, pi, gh) or list available agents with agent: 'list'.";
	readonly parameters = callExternalAgentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	constructor(private readonly session: MinimalSession) {}

	async execute(
		_toolCallId: string,
		params: CallExternalAgentParams,
		signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// Listing mode
		if (params.agent.toLowerCase() === "list") {
			const discovery = await detectExternalAgents();

			const installedLines = discovery.installed.map(
				a =>
					`  - **${a.id}** (${a.displayName}): \`${a.binaryPath}\`${a.version ? ` [v${a.version}]` : ""}`,
			);
			const uninstalledLines = discovery.uninstalled.map(
				(a: { id: string; displayName: string }) => `  - **${a.id}** (${a.displayName}) — not found in PATH`,
			);

			const output = [
				"### Installed External Agents",
				installedLines.length > 0 ? installedLines.join("\n") : "  (none detected)",
				"",
				"### Uninstalled / Not in PATH",
				uninstalledLines.length > 0 ? uninstalledLines.join("\n") : "  (none)",
			].join("\n");

			return {
				content: [{ type: "text", text: output }],
				details: discovery,
			};
		}

		// Require prompt for actual execution
		if (!params.prompt) {
			return {
				content: [
					{
						type: "text",
						text: "Error: 'prompt' is required when invoking an external agent. To check installed agents, use agent: 'list'.",
					},
				],
			};
		}

		try {
			const result = await executeExternalAgent({
				agentId: params.agent,
				prompt: params.prompt,
				options: {
					cwd: params.cwd ?? this.session.cwd,
					background: params.background,
					extraArgs: params.extraArgs,
					customBinary: params.customBinary,
					timeoutMs: params.timeoutMs,
				},
				signal,
			});

			// Background job response
			if (result.backgroundJob) {
				return {
					content: [
						{
							type: "text",
							text: [
								`### External Agent: ${result.agent} (background)`,
								`**Job ID**: \`${result.backgroundJob.jobId}\``,
								`**Status**: running`,
								"",
								result.backgroundJob.message,
							].join("\n"),
						},
					],
					details: result,
				};
			}

			// Sync execution response
			const lines: string[] = [
				`### External Agent Execution: ${result.agent}`,
				`**Exit Code**: ${result.exitCode ?? "N/A"}${result.timedOut ? " *(timed out)*" : ""}`,
				`**Duration**: ${(result.durationMs / 1000).toFixed(2)}s`,
			];
			if (result.stdout) {
				lines.push("", "#### Output", "```", result.stdout, "```");
			}
			if (result.stderr) {
				lines.push("", "#### Stderr", "```", result.stderr, "```");
			}
			if (result.error) {
				lines.push("", `**Error**: ${result.error}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: result,
			};
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: `External Agent Error: ${message}`,
					},
				],
			};
		}
	}
}
