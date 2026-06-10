import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";

export interface Task {
	id: string;
	subject: string;
	description: string;
	status: "pending" | "in_progress" | "completed" | "stopped";
	activeForm?: string;
	metadata?: Record<string, unknown>;
	blocks: string[];
	blockedBy: string[];
}

interface TasksData {
	tasks: Record<string, Task>;
	highestId: number;
}

const tasksFilePath = path.join(os.homedir(), ".aery", "tasks.json");

async function ensureTasksFile(): Promise<void> {
	const dir = path.dirname(tasksFilePath);
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch {}
	try {
		await fs.access(tasksFilePath);
	} catch {
		await fs.writeFile(tasksFilePath, JSON.stringify({ tasks: {}, highestId: 0 }, null, 2), "utf8");
	}
}

async function readTasks(): Promise<TasksData> {
	await ensureTasksFile();
	const content = await fs.readFile(tasksFilePath, "utf8");
	try {
		return JSON.parse(content) as TasksData;
	} catch {
		return { tasks: {}, highestId: 0 };
	}
}

async function writeTasks(data: TasksData): Promise<void> {
	await ensureTasksFile();
	await fs.writeFile(tasksFilePath, JSON.stringify(data, null, 2), "utf8");
}

const taskCreateSchema = z.object({
	subject: z.string().describe("A brief title for the task"),
	description: z.string().describe("What needs to be done"),
	activeForm: z.string().optional().describe("Present continuous form"),
	blocks: z.array(z.string()).optional(),
	blockedBy: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export class TaskCreateTool implements AgentTool<typeof taskCreateSchema, { task: Task }> {
	readonly loadMode = "discoverable";
	readonly name = "task_create";
	readonly label = "Create Task";
	readonly description = "Create a new task in the task tracker.";
	readonly summary = "Create a new task in the task tracker.";
	readonly parameters = taskCreateSchema;

	async execute(
		_toolCallId: string,
		params: z.infer<typeof taskCreateSchema>,
	): Promise<AgentToolResult<{ task: Task }>> {
		const data = await readTasks();
		data.highestId++;
		const id = String(data.highestId);
		const task: Task = {
			id,
			subject: params.subject,
			description: params.description,
			activeForm: params.activeForm,
			status: "pending",
			blocks: params.blocks ?? [],
			blockedBy: params.blockedBy ?? [],
			metadata: params.metadata,
		};
		data.tasks[id] = task;
		await writeTasks(data);
		return {
			content: [{ type: "text", text: `Task #${id} created successfully: ${task.subject}` }],
			details: { task },
		};
	}
}

const taskUpdateSchema = z.object({
	id: z.string().describe("Task ID to update"),
	subject: z.string().optional(),
	description: z.string().optional(),
	activeForm: z.string().optional(),
	status: z.enum(["pending", "in_progress", "completed", "stopped"]).optional(),
});

export class TaskUpdateTool implements AgentTool<typeof taskUpdateSchema, { task: Task }> {
	readonly loadMode = "discoverable";
	readonly name = "task_update";
	readonly approval = "read";
	readonly label = "Update Task";
	readonly description = "Update an existing task in the task tracker.";
	readonly summary = "Update an existing task in the task tracker.";
	readonly parameters = taskUpdateSchema;

	async execute(
		_toolCallId: string,
		params: z.infer<typeof taskUpdateSchema>,
	): Promise<AgentToolResult<{ task: Task }>> {
		const data = await readTasks();
		const task = data.tasks[params.id];
		if (!task) throw new Error(`Task #${params.id} not found`);

		if (params.subject !== undefined) task.subject = params.subject;
		if (params.description !== undefined) task.description = params.description;
		if (params.activeForm !== undefined) task.activeForm = params.activeForm;
		if (params.status !== undefined) task.status = params.status;

		await writeTasks(data);
		return {
			content: [{ type: "text", text: `Task #${params.id} updated successfully.` }],
			details: { task },
		};
	}
}

const taskStopSchema = z.object({
	id: z.string().describe("Task ID to stop"),
});

export class TaskStopTool implements AgentTool<typeof taskStopSchema, { task: Task }> {
	readonly loadMode = "discoverable";
	readonly name = "task_stop";
	readonly approval = "read";
	readonly label = "Stop Task";
	readonly description = "Stop/Cancel an existing task.";
	readonly summary = "Stop/Cancel an existing task.";
	readonly parameters = taskStopSchema;

	async execute(
		_toolCallId: string,
		params: z.infer<typeof taskStopSchema>,
	): Promise<AgentToolResult<{ task: Task }>> {
		const data = await readTasks();
		const task = data.tasks[params.id];
		if (!task) throw new Error(`Task #${params.id} not found`);

		task.status = "stopped";
		await writeTasks(data);

		return {
			content: [{ type: "text", text: `Task #${params.id} stopped.` }],
			details: { task },
		};
	}
}

const taskGetSchema = z.object({
	id: z.string().describe("Task ID to retrieve"),
});

export class TaskGetTool implements AgentTool<typeof taskGetSchema, { task: Task }> {
	readonly loadMode = "discoverable";
	readonly name = "task_get";
	readonly approval = "read";
	readonly label = "Get Task";
	readonly description = "Get details of a specific task.";
	readonly summary = "Get details of a specific task.";
	readonly parameters = taskGetSchema;

	async execute(_toolCallId: string, params: z.infer<typeof taskGetSchema>): Promise<AgentToolResult<{ task: Task }>> {
		const data = await readTasks();
		const task = data.tasks[params.id];
		if (!task) throw new Error(`Task #${params.id} not found`);
		return {
			content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
			details: { task },
		};
	}
}

const taskListSchema = z.object({
	status: z.enum(["pending", "in_progress", "completed", "stopped"]).optional().describe("Filter by status"),
});

export class TaskListTool implements AgentTool<typeof taskListSchema, { tasks: Task[] }> {
	readonly loadMode = "discoverable";
	readonly name = "task_list";
	readonly approval = "read";
	readonly label = "List Tasks";
	readonly description = "List all tasks in the task tracker.";
	readonly summary = "List all tasks in the task tracker.";
	readonly parameters = taskListSchema;

	async execute(
		_toolCallId: string,
		params: z.infer<typeof taskListSchema>,
	): Promise<AgentToolResult<{ tasks: Task[] }>> {
		const data = await readTasks();
		let tasks = Object.values(data.tasks);
		if (params.status) {
			tasks = tasks.filter(t => t.status === params.status);
		}
		return {
			content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
			details: { tasks },
		};
	}
}
