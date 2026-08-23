/**
 * Read streaming output from a background job without blocking.
 *
 * Inspired by Reasonix's `bash_output` tool. Background jobs accumulate
 * output; this tool reads only what's new since the last read, so the
 * agent can poll progress without blocking the TUI session.
 *
 * Workflow:
 *   bash(command="sudo apt install x", pty=true, async=true) → jobId bg_1
 *   bash_output(jobId="bg_1") → "[sudo] password for user:"
 *   send_input(jobId="bg_1", input="password\n")
 *   bash_output(jobId="bg_1") → "Reading package lists..."
 *   bash_output(jobId="bg_1") → "" (done, status: "completed")
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { AsyncJobManager } from "../async/job-manager";
import type { ToolSession } from "./index";

const bashOutputSchema = z.object({
	jobId: z.string().describe("Background job ID to read output from"),
});

export type BashOutputParams = z.infer<typeof bashOutputSchema>;

export class BashOutputTool implements AgentTool<typeof bashOutputSchema> {
	readonly name = "bash_output";
	readonly approval = "read" as const;
	readonly label = "Bash Output";
	readonly description =
		"Read new output from a background job without blocking. Use after starting a bash job with async=true to poll progress.";
	readonly parameters = bashOutputSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Read streaming background job output";

	constructor(readonly _session: ToolSession) {}

	static createIf(_session: ToolSession): BashOutputTool | null {
		return new BashOutputTool(_session);
	}

	async execute(_id: string, params: BashOutputParams): Promise<AgentToolResult> {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			return {
				content: [{ type: "text", text: "Background job manager unavailable for this session." }],
				details: { jobId: params.jobId, found: false },
			};
		}

		const output = manager.readOutput(params.jobId);
		if (!output) {
			return {
				content: [{ type: "text", text: `No active background job found for ${params.jobId}.` }],
				details: { jobId: params.jobId, found: false },
			};
		}

		const statusLabel = output.done ? ` (${output.status})` : " (running)";
		const text = output.text.length > 0 ? output.text : "(no new output)";

		return {
			content: [{ type: "text", text: `## Job ${params.jobId}${statusLabel}\n\n${text}` }],
			details: {
				jobId: params.jobId,
				status: output.status,
				done: output.done,
				newBytes: output.text.length,
			},
		};
	}
}
