/**
 * Send stdin to a running background interactive command.
 *
 * When bash runs with pty: true in background mode, the command may need
 * user input (passwords, sudo, ssh passphrases, y/n prompts). This tool
 * writes stdin to that running command so it can continue.
 *
 * Use this after the agent receives output indicating the command is waiting
 * for input (e.g., "[sudo] password for user:", "Enter passphrase:", or
 * "Do you want to continue? [Y/n]").
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { getInteractiveSession, writeInteractiveSession } from "./bash-interactive-session";
import type { ToolSession } from "./index";

const sendInputSchema = z.object({
	jobId: z.string().describe("Background job ID of the running interactive command"),
	input: z.string().describe("Input to send (include \\n if Enter should be pressed)"),
});

export type SendInputParams = z.infer<typeof sendInputSchema>;

export class SendInputTool implements AgentTool<typeof sendInputSchema> {
	readonly name = "send_input";
	readonly approval = "exec" as const;
	readonly label = "Send Input";
	readonly description =
		"Send stdin to a running background interactive command (password, sudo, ssh passphrase, y/n prompt). Use when the command output shows it's waiting for input.";
	readonly parameters = sendInputSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	static createIf(_session: ToolSession): SendInputTool | null {
		return new SendInputTool();
	}

	async execute(_id: string, params: SendInputParams): Promise<AgentToolResult> {
		const state = getInteractiveSession(params.jobId);
		if (!state) {
			return {
				content: [
					{
						type: "text",
						text: `No active interactive session found for job ${params.jobId}. Use bash with pty: true to start an interactive command.`,
					},
				],
				details: { jobId: params.jobId, found: false },
			};
		}

		if (state.status !== "running") {
			return {
				content: [
					{
						type: "text",
						text: `Session ${params.jobId} is ${state.status} (exit code: ${state.exitCode}). Cannot send input to a finished command.`,
					},
				],
				details: { jobId: params.jobId, status: state.status, exitCode: state.exitCode },
			};
		}

		const sent = writeInteractiveSession(params.jobId, params.input);
		if (!sent) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to send input to job ${params.jobId}. The session may have closed.`,
					},
				],
				details: { jobId: params.jobId, sent: false },
			};
		}

		const displayInput = params.input.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
		return {
			content: [
				{
					type: "text",
					text: `Sent input to job ${params.jobId}: "${displayInput}"\n\nThe command should continue. Check the job output for the result.`,
				},
			],
			details: { jobId: params.jobId, sent: true, input: params.input },
		};
	}
}
