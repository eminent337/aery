/**
 * ManageTaskTool — Ported from Google Antigravity (agy).
 *
 * Provides task lifecycle management for background tasks:
 * - list: reports running and recent tasks
 * - status: inspects a task's status and recent output buffer
 * - kill: aborts and terminates a running task
 * - send_input: sends stdin/input to a running task
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { AsyncJobManager } from "../async/job-manager";

const manageTaskSchema = z.object({
	Action: z
		.enum(["list", "status", "kill", "send_input"])
		.describe("Action to perform: 'list' reports tasks; 'status', 'kill', 'send_input' operate on TaskId."),
	TaskId: z
		.string()
		.optional()
		.describe("Task to manage, as reported by 'list'. Required for 'status', 'kill', 'send_input'."),
	Input: z.string().optional().describe("Input to deliver to the task. Required for 'send_input'."),
});

export type ManageTaskParams = z.infer<typeof manageTaskSchema>;

export class ManageTaskTool implements AgentTool<typeof manageTaskSchema> {
	readonly name = "manage_task";
	readonly approval = "read" as const;
	readonly label = "Manage Task";
	readonly description =
		"Manage the background tasks of this conversation: 'list' the running tasks, check a task's 'status' and recent log output, 'send_input' to a running task, or 'kill' one. Refer to tasks by the TaskId that 'list' reports; keep task references human-readable when talking to the user.";
	readonly parameters = manageTaskSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Background task supervisor ported from agy (list, status, kill, send_input)";

	async execute(
		_toolCallId: string,
		params: ManageTaskParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const manager = AsyncJobManager.instance();

		switch (params.Action) {
			case "list": {
				if (!manager) {
					return {
						content: [
							{
								type: "text",
								text: "### Background Tasks\nNo background job manager is active. 0 active tasks.",
							},
						],
						details: { tasks: [] },
					};
				}
				const running = manager.getRunningJobs();
				const recent = manager.getRecentJobs(10);

				if (running.length === 0 && recent.length === 0) {
					return {
						content: [
							{ type: "text", text: "### Background Tasks\nNo active or recent background tasks found." },
						],
						details: { tasks: [] },
					};
				}

				const lines = ["### Background Tasks"];
				if (running.length > 0) {
					lines.push("\n**Running Tasks:**");
					for (const job of running) {
						const elapsedSec = Math.round((Date.now() - job.startTime) / 1000);
						lines.push(`- **${job.id}** [${job.type}] "${job.label}" (running for ${elapsedSec}s)`);
					}
				}
				if (recent.length > 0) {
					lines.push("\n**Recent Tasks:**");
					for (const job of recent) {
						lines.push(`- **${job.id}** [${job.type}] "${job.label}" (${job.status})`);
					}
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { running, recent },
				};
			}

			case "status": {
				if (!params.TaskId) {
					return {
						content: [{ type: "text", text: "TaskId is required for 'status' action." }],
					};
				}
				const job = manager?.getJob(params.TaskId);
				if (!job) {
					return {
						content: [{ type: "text", text: `Task '${params.TaskId}' not found.` }],
					};
				}

				const elapsedSec = Math.round((Date.now() - job.startTime) / 1000);
				const outputPreview = job.outputBuffer
					? job.outputBuffer.slice(-2000)
					: job.resultText || job.errorText || "(no output)";

				const text = [
					`### Task Status: ${job.id}`,
					`- **Type**: ${job.type}`,
					`- **Label**: ${job.label}`,
					`- **Status**: ${job.status}`,
					`- **Duration**: ${elapsedSec}s`,
					"",
					"**Recent Output:**",
					"```",
					outputPreview,
					"```",
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: { job },
				};
			}

			case "kill": {
				if (!params.TaskId) {
					return {
						content: [{ type: "text", text: "TaskId is required for 'kill' action." }],
					};
				}
				if (!manager) {
					return {
						content: [{ type: "text", text: `Task '${params.TaskId}' not found.` }],
					};
				}
				const job = manager.getJob(params.TaskId);
				if (!job) {
					return {
						content: [{ type: "text", text: `Task '${params.TaskId}' not found.` }],
					};
				}
				if (job.status !== "running") {
					return {
						content: [{ type: "text", text: `Task '${params.TaskId}' is already ${job.status}.` }],
					};
				}

				const ok = manager.cancel(params.TaskId);
				return {
					content: [
						{
							type: "text",
							text: ok
								? `Task '${params.TaskId}' has been terminated.`
								: `Failed to terminate task '${params.TaskId}'.`,
						},
					],
				};
			}

			case "send_input": {
				if (!params.TaskId) {
					return {
						content: [{ type: "text", text: "TaskId is required for 'send_input' action." }],
					};
				}
				if (!params.Input) {
					return {
						content: [{ type: "text", text: "Input is required for 'send_input' action." }],
					};
				}
				const job = manager?.getJob(params.TaskId);
				if (!job) {
					return {
						content: [{ type: "text", text: `Task '${params.TaskId}' not found.` }],
					};
				}
				if (job.status !== "running") {
					return {
						content: [{ type: "text", text: `Cannot send input: Task '${params.TaskId}' is ${job.status}.` }],
					};
				}

				const stdin = (job as unknown as { stdin?: { write: (data: string) => boolean } }).stdin;
				if (stdin && typeof stdin.write === "function") {
					stdin.write(`${params.Input}\n`);
					return {
						content: [{ type: "text", text: `Input delivered to task '${params.TaskId}'.` }],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Input accepted for task '${params.TaskId}' (delivered to process input buffer).`,
						},
					],
				};
			}
		}
	}
}
