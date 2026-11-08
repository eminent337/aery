/**
 * Persistent Scheduled Task Watcher tool.
 *
 * Provides persistent task scheduling storage, lifecycle status controls,
 * execution history audit logging, and AgentTool integration.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@aryee337/aery-core";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "zod/v4";

export interface ScheduledTask {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	lastRunAt?: number;
	metadata?: Record<string, unknown>;
}

export interface TaskExecutionRecord {
	id: string;
	taskId: string;
	taskName?: string;
	status: "success" | "failure" | "running" | "skipped" | string;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	output?: string;
	error?: string;
}

export interface CreateTaskOptions {
	id?: string;
	name: string;
	schedule: string;
	prompt: string;
	enabled?: boolean;
	metadata?: Record<string, unknown>;
}

export interface RecordExecutionOptions {
	taskId: string;
	taskName?: string;
	status: "success" | "failure" | "running" | "skipped" | string;
	id?: string;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	output?: string;
	error?: string;
}

export interface HistoryFilterOptions {
	taskId?: string;
	task_id?: string;
	limit?: number;
}

export interface ScheduledTaskWatcherOptions {
	storagePath?: string;
}

/**
 * ScheduledTaskWatcher manages tasks and audit history with atomic persistence.
 */
export class ScheduledTaskWatcher {
	private readonly storagePath: string | null;
	private tasks: ScheduledTask[] = [];
	private history: TaskExecutionRecord[] = [];

	constructor(options?: string | ScheduledTaskWatcherOptions) {
		if (typeof options === "string") {
			this.storagePath = options;
		} else if (options && typeof options === "object") {
			this.storagePath = options.storagePath ?? null;
		} else {
			this.storagePath = path.join(os.homedir(), ".aery", "scheduled-tasks.json");
		}

		this.load();
	}

	private load(): void {
		if (!this.storagePath) return;

		try {
			if (!fs.existsSync(this.storagePath)) {
				return;
			}
			const content = fs.readFileSync(this.storagePath, "utf8");
			const parsed = JSON.parse(content);

			if (Array.isArray(parsed.tasks)) {
				this.tasks = parsed.tasks;
			} else if (parsed.tasks && typeof parsed.tasks === "object") {
				this.tasks = Object.values(parsed.tasks);
			}

			if (Array.isArray(parsed.history)) {
				this.history = parsed.history;
			}
		} catch {
			this.tasks = [];
			this.history = [];
		}
	}

	private save(): void {
		if (!this.storagePath) return;

		try {
			const dir = path.dirname(this.storagePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const randomId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
			const tempFile = path.join(
				dir,
				`.tmp_${path.basename(this.storagePath)}_${Date.now()}_${randomId}`,
			);
			const data = JSON.stringify(
				{
					tasks: this.tasks,
					history: this.history,
				},
				null,
				2,
			);

			fs.writeFileSync(tempFile, data, "utf8");
			fs.renameSync(tempFile, this.storagePath);
		} catch (error) {
			console.error("ScheduledTaskWatcher: persistence write failed", error);
		}
	}

	createTask(options: CreateTaskOptions): ScheduledTask {
		const now = Date.now();
		const taskId = options.id ?? `task_${now}_${Math.random().toString(36).slice(2, 8)}`;

		const task: ScheduledTask = {
			id: taskId,
			name: options.name,
			schedule: options.schedule,
			prompt: options.prompt,
			enabled: options.enabled ?? true,
			createdAt: now,
			updatedAt: now,
			metadata: options.metadata,
		};

		this.tasks.push(task);
		this.save();
		return task;
	}

	create(options: CreateTaskOptions): ScheduledTask {
		return this.createTask(options);
	}

	listTasks(filter?: { enabled?: boolean }): ScheduledTask[] {
		if (filter && filter.enabled !== undefined) {
			return this.tasks.filter((t) => t.enabled === filter.enabled);
		}
		return [...this.tasks];
	}

	list(filter?: { enabled?: boolean }): ScheduledTask[] {
		return this.listTasks(filter);
	}

	getTask(id: string): ScheduledTask | undefined {
		return this.tasks.find((t) => t.id === id);
	}

	updateTaskStatus(id: string, enabled: boolean): ScheduledTask {
		const task = this.getTask(id);
		if (!task) {
			throw new Error(`Scheduled task with id '${id}' not found`);
		}

		task.enabled = enabled;
		task.updatedAt = Date.now();
		this.save();
		return task;
	}

	updateStatus(id: string, enabled: boolean): ScheduledTask {
		return this.updateTaskStatus(id, enabled);
	}

	recordExecution(options: RecordExecutionOptions): TaskExecutionRecord {
		const now = Date.now();
		const recordId = options.id ?? `exec_${now}_${Math.random().toString(36).slice(2, 8)}`;

		const record: TaskExecutionRecord = {
			id: recordId,
			taskId: options.taskId,
			taskName: options.taskName,
			status: options.status,
			startedAt: options.startedAt ?? now,
			completedAt: options.completedAt,
			durationMs: options.durationMs,
			output: options.output,
			error: options.error,
		};

		const task = this.getTask(options.taskId);
		if (task) {
			task.lastRunAt = record.startedAt;
			task.updatedAt = now;
			if (!record.taskName) {
				record.taskName = task.name;
			}
		}

		this.history.push(record);
		this.save();
		return record;
	}

	recordHistory(options: RecordExecutionOptions): TaskExecutionRecord {
		return this.recordExecution(options);
	}

	getHistory(filter?: HistoryFilterOptions): TaskExecutionRecord[] {
		const targetTaskId = filter?.taskId ?? filter?.task_id;
		let results = [...this.history];

		if (targetTaskId) {
			results = results.filter((r) => r.taskId === targetTaskId);
		}

		if (filter?.limit && filter.limit > 0) {
			results = results.slice(-filter.limit);
		}

		return results;
	}

	clearHistory(taskId?: string): number {
		if (!taskId) {
			const count = this.history.length;
			this.history = [];
			this.save();
			return count;
		}

		const previousCount = this.history.length;
		this.history = this.history.filter((r) => r.taskId !== taskId);
		const cleared = previousCount - this.history.length;
		this.save();
		return cleared;
	}
}

export const scheduledTaskWatcherSchema = z.object({
	action: z
		.enum(["create", "list", "update_status", "history", "clear_history"])
		.describe("Action to perform: create, list, update_status, history, or clear_history."),
	id: z.string().optional().describe("Task identifier for status updates."),
	name: z.string().optional().describe("Descriptive name for the task."),
	schedule: z.string().optional().describe("Schedule expression such as cron or interval."),
	prompt: z.string().optional().describe("Prompt or instruction to execute on schedule."),
	enabled: z.boolean().optional().describe("Whether the task is enabled."),
	taskId: z.string().optional().describe("Task ID for filtering or clearing history."),
	task_id: z.string().optional().describe("Alternative snake_case task ID for history actions."),
	limit: z.number().int().positive().optional().describe("Maximum history entries to return."),
	metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata dictionary."),
});

export type ScheduledTaskWatcherParams = z.infer<typeof scheduledTaskWatcherSchema>;

export interface ScheduledTaskWatcherToolOptions {
	watcher?: ScheduledTaskWatcher;
	storagePath?: string;
}

let defaultScheduledTaskWatcher: ScheduledTaskWatcher | null = null;

export function getDefaultScheduledTaskWatcher(): ScheduledTaskWatcher {
	if (!defaultScheduledTaskWatcher) {
		defaultScheduledTaskWatcher = new ScheduledTaskWatcher();
	}
	return defaultScheduledTaskWatcher;
}

/**
 * ScheduledTaskWatcherTool provides tool interface for AgentTool execution.
 */
export class ScheduledTaskWatcherTool implements AgentTool<typeof scheduledTaskWatcherSchema> {
	readonly name = "scheduled_task_watcher";
	readonly approval = "exec" as const;
	readonly label = "Scheduled Task Watcher";
	readonly summary = "Persistent scheduled task watcher and history audit log";
	readonly description =
		"Manage persistent scheduled tasks, update status, and view execution history.";
	readonly parameters = scheduledTaskWatcherSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	readonly watcher: ScheduledTaskWatcher;

	constructor(options?: ScheduledTaskWatcherToolOptions) {
		if (options?.watcher) {
			this.watcher = options.watcher;
		} else if (options?.storagePath) {
			this.watcher = new ScheduledTaskWatcher({ storagePath: options.storagePath });
		} else {
			this.watcher = getDefaultScheduledTaskWatcher();
		}
	}

	static createIf(_session?: unknown): ScheduledTaskWatcherTool | null {
		return new ScheduledTaskWatcherTool();
	}

	async execute(
		_toolCallId: string,
		params: ScheduledTaskWatcherParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		switch (params.action) {
			case "create": {
				if (!params.name || !params.schedule || !params.prompt) {
					throw new Error(
						"Missing required parameters: name, schedule, and prompt must be provided for action 'create'",
					);
				}

				const task = this.watcher.createTask({
					id: params.id,
					name: params.name,
					schedule: params.schedule,
					prompt: params.prompt,
					enabled: params.enabled,
					metadata: params.metadata,
				});

				return {
					content: [
						{
							type: "text",
							text: `Scheduled task created: ${task.name} (${task.id}) on schedule '${task.schedule}'`,
						},
					],
					details: {
						action: "create",
						task,
					},
				};
			}

			case "list": {
				const tasks = this.watcher.listTasks(
					params.enabled !== undefined ? { enabled: params.enabled } : undefined,
				);

				const lines = [
					`Scheduled Tasks (${tasks.length} total):`,
					...tasks.map(
						(t) => `• [${t.enabled ? "ENABLED" : "DISABLED"}] ${t.name} (id: ${t.id}, schedule: ${t.schedule})`,
					),
				];

				return {
					content: [
						{
							type: "text",
							text: lines.join("\n"),
						},
					],
					details: {
						action: "list",
						tasks,
					},
				};
			}

			case "update_status": {
				const taskId = params.id ?? params.taskId ?? params.task_id;
				if (!taskId) {
					throw new Error("Parameter 'id' is required for action 'update_status'");
				}
				if (params.enabled === undefined) {
					throw new Error("Parameter 'enabled' is required for action 'update_status'");
				}

				const task = this.watcher.updateTaskStatus(taskId, params.enabled);

				return {
					content: [
						{
							type: "text",
							text: `Task status updated: ${task.name} (${task.id}) is now ${task.enabled ? "enabled" : "disabled"}`,
						},
					],
					details: {
						action: "update_status",
						task,
					},
				};
			}

			case "history": {
				const taskId = params.taskId ?? params.task_id ?? params.id;
				const history = this.watcher.getHistory({
					taskId,
					limit: params.limit,
				});

				const lines = [
					`Execution History Audit Log (${history.length} records):`,
					...history.map(
						(h) =>
							`• [${h.status.toUpperCase()}] task: ${h.taskId} at ${new Date(h.startedAt).toISOString()}${h.output ? ` (output: ${h.output})` : ""}${h.error ? ` (error: ${h.error})` : ""}`,
					),
				];

				return {
					content: [
						{
							type: "text",
							text: lines.join("\n"),
						},
					],
					details: {
						action: "history",
						history,
					},
				};
			}

			case "clear_history": {
				const taskId = params.taskId ?? params.task_id ?? params.id;
				const cleared = this.watcher.clearHistory(taskId);

				return {
					content: [
						{
							type: "text",
							text: taskId
								? `Cleared ${cleared} execution history records for task ${taskId}`
								: `Cleared all ${cleared} execution history records`,
						},
					],
					details: {
						action: "clear_history",
						cleared,
					},
				};
			}
		}
	}
}
