/**
 * Schedule tool — queue a future ambient task in the priority scheduler.
 *
 * Ported from jcode upstream (crates/jcode-app-core/src/tool/ambient.rs
 * ScheduleTool). Creates a ScheduledItem with a future due time and
 * priority, delivered via the ambient event bus.
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import { AmbientScheduler, type SchedulePriority } from "../ambient/scheduler";
import type { ToolSession } from "./index";

const scheduleSchema = z.object({
	message: z.string().describe("Message content for the scheduled task"),
	dueAt: z.number().int().describe("Unix timestamp (ms) for when the task should fire"),
	priority: z.enum(["low", "normal", "high"]).optional().describe("Task priority (default normal)"),
	metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
});

export type ScheduleToolParams = z.infer<typeof scheduleSchema>;

const PRIORITY_SET: ReadonlySet<string> = new Set(["low", "normal", "high"]);

export class ScheduleTool implements AgentTool<typeof scheduleSchema> {
	readonly name = "schedule";
	readonly approval = "read" as const;
	readonly label = "Schedule";
	readonly description =
		"Queue a future ambient task. The task fires at `dueAt` (unix ms) and is delivered to this session via the ambient event bus. Use for deferred follow-ups, reminders, and proactive background work.";
	readonly parameters = scheduleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Queue a future ambient task with priority";

	constructor(private readonly scheduler: AmbientScheduler) {}

	static createIf(session: ToolSession): ScheduleTool | null {
		const bus = session.eventBus;
		if (!bus) return null;
		const sessionId = session.getSessionId?.() ?? "default";
		const scheduler = new AmbientScheduler(sessionId, bus);
		return new ScheduleTool(scheduler);
	}

	async execute(_id: string, params: ScheduleToolParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const priority: SchedulePriority = PRIORITY_SET.has(params.priority ?? "") ? params.priority! : "normal";
			const item = this.scheduler.schedule({
				id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				dueAt: params.dueAt,
				priority,
				sessionId: this.scheduler.sessionId,
				message: params.message,
				metadata: params.metadata,
			});

			return {
				content: [
					{
						type: "text",
						text: `Scheduled task ${item.id} at ${new Date(item.dueAt).toISOString()} (${item.priority}). Scheduler has ${this.scheduler.size} item(s).`,
					},
				],
				details: { id: item.id, dueAt: item.dueAt, priority: item.priority, queueSize: this.scheduler.size },
			};
		});
	}
}
