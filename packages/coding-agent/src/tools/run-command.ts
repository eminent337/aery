/**
 * RunCommandTool — Ported from Google Antigravity (agy).
 *
 * Direct agy-compatible command execution tool matching `run_command`:
 * - CommandLine: command line to execute
 * - WaitMsBeforeAsync: milliseconds to wait before async backgrounding
 * - IsDaemon: whether process is a standing daemon
 * - toolSummary: brief description of the command
 */

import * as z from "zod/v4";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import { BashTool, type BashToolDetails } from "./bash";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const runCommandSchema = z.object({
	CommandLine: z.string().optional().describe("The exact command line string to execute."),
	WaitMsBeforeAsync: z
		.number()
		.optional()
		.describe("Milliseconds to wait for the command to finish before backgrounding it (500 to 10000)."),
	IsDaemon: z
		.boolean()
		.optional()
		.describe("Set to true for long-running support processes that should keep running in background."),
	toolSummary: z.string().optional().describe("Brief 2–5 word noun phrase describing the command task."),
	commandLine: z.string().optional().describe("Command line (lowercase alias)."),
	waitMsBeforeAsync: z.number().optional().describe("Wait ms (lowercase alias)."),
	isDaemon: z.boolean().optional().describe("Daemon flag (lowercase alias)."),
});

export type RunCommandParams = z.infer<typeof runCommandSchema>;

export class RunCommandTool implements AgentTool<typeof runCommandSchema, BashToolDetails> {
	readonly name = "run_command";
	readonly approval = "exec" as const;
	readonly label = "Run Command";
	readonly description =
		"Execute a command in the workspace. Operating System: linux. Shell: bash. Each command runs in a new session. Commands that do not finish within the specified wait time continue running in the background as tasks.";
	readonly parameters = runCommandSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Command execution tool matching agy run_command schema";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RunCommandTool {
		return new RunCommandTool(session);
	}

	async execute(
		toolCallId: string,
		params: RunCommandParams,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const command = params.CommandLine ?? params.commandLine;
		const waitMs = params.WaitMsBeforeAsync ?? params.waitMsBeforeAsync ?? 10000;
		const isDaemon = params.IsDaemon ?? params.isDaemon ?? false;

		if (!command || !command.trim()) {
			throw new ToolError("CommandLine is required for run_command.");
		}

		const bashTool = new BashTool(this.session);
		const timeoutSeconds = Math.max(1, Math.ceil(waitMs / 1000));

		return (bashTool as any).execute(
			toolCallId,
			{
				command: command.trim(),
				timeout: timeoutSeconds,
				async: isDaemon,
			},
			signal,
			onUpdate,
			context,
		);
	}
}
