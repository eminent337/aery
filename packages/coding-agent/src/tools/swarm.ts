import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import os from "os";
import path from "path";
import * as z from "zod/v4";
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

export class InvokeSubagentTool implements AgentTool<typeof invokeSubagentSchema, any> {
	readonly name = "invoke_subagent";
	readonly approval = "write" as const;
	readonly label = "Invoke Subagent";
	readonly summary = "Launch background subagents";
	readonly description =
		"Invokes one or more subagents in the background. Each entry defines a separate subagent to launch concurrently.";
	readonly parameters = invokeSubagentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): InvokeSubagentTool | null {
		return new InvokeSubagentTool(session);
	}

	async execute(_toolCallId: string, params: z.infer<typeof invokeSubagentSchema>): Promise<AgentToolResult<any>> {
		const invokedIds: string[] = [];
		const skillsDir = path.join(this.session.cwd, ".agents/skills");

		for (const subagent of params.Subagents) {
			const id = Math.random().toString(36).substring(2, 10);
			invokedIds.push(id);

			// File streaming: The orchestrator Aery will tail this stream file
			// to show live thought-process in the TUI FlexBox grid pane.
			const logFile = path.join(os.tmpdir(), `aery-subagent-${id}.stream`);
			const stream = createWriteStream(logFile, { flags: "a" });
			stream.write(`[INIT] Subagent ${id} (${subagent.Role}) starting...\n`);

			const child = spawn(
				"aery",
				["--headless", "--role", subagent.Role, "--prompt", subagent.Prompt, "--skills", skillsDir],
				{
					cwd: this.session.cwd,
					stdio: ["ignore", "pipe", "pipe"],
					detached: true,
				},
			);

			if (child.stdout) {
				child.stdout.pipe(stream);
			}
			if (child.stderr) {
				child.stderr.pipe(stream);
			}

			child.unref();
		}

		let text = `Successfully invoked ${params.Subagents.length} subagents.\n`;
		for (const id of invokedIds) {
			text += `- Subagent ID: ${id}\n  Live stream: ${path.join(os.tmpdir(), `aery-subagent-${id}.stream`)}\n`;
		}

		return {
			content: [{ type: "text", text }],
			details: { invokedIds },
		};
	}
}
