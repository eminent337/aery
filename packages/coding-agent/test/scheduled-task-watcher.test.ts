import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ScheduledTaskWatcher,
	ScheduledTaskWatcherTool,
	scheduledTaskWatcherSchema,
} from "../src/tools/scheduled-task-watcher";

describe("ScheduledTaskWatcher", () => {
	let tempDir: string;
	let storagePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-test-"));
		storagePath = path.join(tempDir, "scheduled-tasks.json");
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("creates tasks with default and custom options", () => {
		const watcher = new ScheduledTaskWatcher({ storagePath });

		const task1 = watcher.createTask({
			name: "Nightly backup",
			schedule: "0 2 * * *",
			prompt: "Run full database backup",
		});

		expect(task1.id).toBeDefined();
		expect(typeof task1.id).toBe("string");
		expect(task1.name).toBe("Nightly backup");
		expect(task1.schedule).toBe("0 2 * * *");
		expect(task1.prompt).toBe("Run full database backup");
		expect(task1.enabled).toBe(true);
		expect(typeof task1.createdAt).toBe("number");
		expect(typeof task1.updatedAt).toBe("number");

		const task2 = watcher.createTask({
			id: "custom-task-42",
			name: "Hourly sync",
			schedule: "0 * * * *",
			prompt: "Synchronize cloud files",
			enabled: false,
			metadata: { owner: "devops" },
		});

		expect(task2.id).toBe("custom-task-42");
		expect(task2.enabled).toBe(false);
		expect(task2.metadata?.owner).toBe("devops");
	});

	test("lists tasks with optional status filter", () => {
		const watcher = new ScheduledTaskWatcher({ storagePath });

		watcher.createTask({
			name: "Task A",
			schedule: "*/5 * * * *",
			prompt: "Ping server",
			enabled: true,
		});
		watcher.createTask({
			name: "Task B",
			schedule: "0 0 * * *",
			prompt: "Purge cache",
			enabled: false,
		});

		const allTasks = watcher.listTasks();
		expect(allTasks.length).toBe(2);

		const enabledTasks = watcher.listTasks({ enabled: true });
		expect(enabledTasks.length).toBe(1);
		expect(enabledTasks[0].name).toBe("Task A");

		const disabledTasks = watcher.listTasks({ enabled: false });
		expect(disabledTasks.length).toBe(1);
		expect(disabledTasks[0].name).toBe("Task B");
	});

	test("updates task enabled status", () => {
		const watcher = new ScheduledTaskWatcher({ storagePath });

		const task = watcher.createTask({
			name: "Health monitor",
			schedule: "*/1 * * * *",
			prompt: "Check endpoint health",
			enabled: true,
		});

		const updated = watcher.updateTaskStatus(task.id, false);
		expect(updated.enabled).toBe(false);
		expect(updated.updatedAt).toBeGreaterThanOrEqual(task.createdAt);

		const retrieved = watcher.getTask(task.id);
		expect(retrieved?.enabled).toBe(false);

		expect(() => watcher.updateTaskStatus("missing-task-id", true)).toThrow();
	});

	test("records execution history and updates lastRunAt", () => {
		const watcher = new ScheduledTaskWatcher({ storagePath });

		const task = watcher.createTask({
			name: "Vulnerability scan",
			schedule: "0 4 * * 0",
			prompt: "Scan dependencies for CVEs",
		});

		const record = watcher.recordExecution({
			taskId: task.id,
			taskName: task.name,
			status: "success",
			durationMs: 1250,
			output: "Zero vulnerabilities found",
		});

		expect(record.id).toBeDefined();
		expect(record.taskId).toBe(task.id);
		expect(record.status).toBe("success");
		expect(record.durationMs).toBe(1250);
		expect(record.output).toBe("Zero vulnerabilities found");
		expect(typeof record.startedAt).toBe("number");

		const updatedTask = watcher.getTask(task.id);
		expect(updatedTask?.lastRunAt).toBeDefined();
		expect(updatedTask?.lastRunAt).toBe(record.startedAt);
	});

	test("retrieves history audit log with optional filter and limit", () => {
		const watcher = new ScheduledTaskWatcher({ storagePath });

		const task1 = watcher.createTask({
			name: "Task 1",
			schedule: "1 * * * *",
			prompt: "Check 1",
		});
		const task2 = watcher.createTask({
			name: "Task 2",
			schedule: "2 * * * *",
			prompt: "Check 2",
		});

		watcher.recordExecution({ taskId: task1.id, status: "success", output: "Run 1" });
		watcher.recordExecution({ taskId: task2.id, status: "failure", error: "Connection timed out" });
		watcher.recordExecution({ taskId: task1.id, status: "success", output: "Run 2" });

		const allHistory = watcher.getHistory();
		expect(allHistory.length).toBe(3);

		const task1History = watcher.getHistory({ taskId: task1.id });
		expect(task1History.length).toBe(2);

		const limitedHistory = watcher.getHistory({ limit: 2 });
		expect(limitedHistory.length).toBe(2);
	});

	test("clears history by taskId or completely", () => {
		const watcher = new ScheduledTaskWatcher({ storagePath });

		const task1 = watcher.createTask({ name: "Task 1", schedule: "1 * * * *", prompt: "Do 1" });
		const task2 = watcher.createTask({ name: "Task 2", schedule: "2 * * * *", prompt: "Do 2" });

		watcher.recordExecution({ taskId: task1.id, status: "success" });
		watcher.recordExecution({ taskId: task1.id, status: "success" });
		watcher.recordExecution({ taskId: task2.id, status: "success" });

		const clearedCount1 = watcher.clearHistory(task1.id);
		expect(clearedCount1).toBe(2);
		expect(watcher.getHistory().length).toBe(1);

		const clearedCountAll = watcher.clearHistory();
		expect(clearedCountAll).toBe(1);
		expect(watcher.getHistory().length).toBe(0);
	});
});

describe("Persistence", () => {
	let tempDir: string;
	let storagePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-persistence-test-"));
		storagePath = path.join(tempDir, "nested", "tasks-store.json");
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("saves tasks and history to a JSON file on disk and reloads on initialization", () => {
		const watcher1 = new ScheduledTaskWatcher({ storagePath });

		const task = watcher1.createTask({
			id: "task-persistent-1",
			name: "Persist me",
			schedule: "0 12 * * *",
			prompt: "Check persistent state",
		});

		watcher1.recordExecution({
			taskId: task.id,
			status: "success",
			output: "Audit record persisted",
		});

		expect(fs.existsSync(storagePath)).toBe(true);
		const rawContent = fs.readFileSync(storagePath, "utf8");
		const parsed = JSON.parse(rawContent);
		expect(parsed.tasks).toBeDefined();
		expect(parsed.history).toBeDefined();
		expect(parsed.tasks.length).toBe(1);
		expect(parsed.history.length).toBe(1);

		const watcher2 = new ScheduledTaskWatcher({ storagePath });
		const loadedTasks = watcher2.listTasks();
		expect(loadedTasks.length).toBe(1);
		expect(loadedTasks[0].id).toBe("task-persistent-1");
		expect(loadedTasks[0].name).toBe("Persist me");

		const loadedHistory = watcher2.getHistory();
		expect(loadedHistory.length).toBe(1);
		expect(loadedHistory[0].taskId).toBe("task-persistent-1");
		expect(loadedHistory[0].output).toBe("Audit record persisted");
	});
});

describe("scheduledTaskWatcherSchema", () => {
	test("validates create action", () => {
		const valid = scheduledTaskWatcherSchema.safeParse({
			action: "create",
			name: "Backup Task",
			schedule: "0 3 * * *",
			prompt: "Perform nightly backup",
			enabled: true,
		});
		expect(valid.success).toBe(true);
	});

	test("validates list action", () => {
		const validAll = scheduledTaskWatcherSchema.safeParse({
			action: "list",
		});
		expect(validAll.success).toBe(true);

		const validFilter = scheduledTaskWatcherSchema.safeParse({
			action: "list",
			enabled: false,
		});
		expect(validFilter.success).toBe(true);
	});

	test("validates update_status action", () => {
		const valid = scheduledTaskWatcherSchema.safeParse({
			action: "update_status",
			id: "task-123",
			enabled: false,
		});
		expect(valid.success).toBe(true);
	});

	test("validates history action", () => {
		const valid1 = scheduledTaskWatcherSchema.safeParse({
			action: "history",
			taskId: "task-123",
			limit: 10,
		});
		expect(valid1.success).toBe(true);

		const valid2 = scheduledTaskWatcherSchema.safeParse({
			action: "history",
			task_id: "task-123",
		});
		expect(valid2.success).toBe(true);
	});

	test("validates clear_history action", () => {
		const valid1 = scheduledTaskWatcherSchema.safeParse({
			action: "clear_history",
			taskId: "task-123",
		});
		expect(valid1.success).toBe(true);

		const valid2 = scheduledTaskWatcherSchema.safeParse({
			action: "clear_history",
		});
		expect(valid2.success).toBe(true);
	});

	test("rejects invalid actions", () => {
		const invalid = scheduledTaskWatcherSchema.safeParse({
			action: "unknown_action",
		});
		expect(invalid.success).toBe(false);
	});
});

describe("ScheduledTaskWatcherTool", () => {
	let tempDir: string;
	let storagePath: string;
	let watcher: ScheduledTaskWatcher;
	let tool: ScheduledTaskWatcherTool;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-tool-test-"));
		storagePath = path.join(tempDir, "tasks.json");
		watcher = new ScheduledTaskWatcher({ storagePath });
		tool = new ScheduledTaskWatcherTool({ watcher });
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("conforms to AgentTool interface", () => {
		expect(tool.name).toBe("scheduled_task_watcher");
		expect(typeof tool.label).toBe("string");
		expect(typeof tool.summary).toBe("string");
		expect(typeof tool.description).toBe("string");
		expect(tool.parameters).toBe(scheduledTaskWatcherSchema);
		expect(typeof tool.execute).toBe("function");
	});

	test("handles execute lifecycle for all actions", async () => {
		const createResult = await tool.execute("call-1", {
			action: "create",
			name: "Lifecycle Task",
			schedule: "*/10 * * * *",
			prompt: "Check system resources",
		});

		expect(createResult.content[0].type).toBe("text");
		expect(createResult.content[0].text).toContain("Lifecycle Task");
		const createdTask = createResult.details?.task;
		expect(createdTask).toBeDefined();
		expect(createdTask.id).toBeDefined();

		const listResult = await tool.execute("call-2", {
			action: "list",
		});
		expect(listResult.content[0].type).toBe("text");
		expect(listResult.details?.action).toBe("list");
		expect(listResult.details?.tasks.length).toBe(1);

		const updateResult = await tool.execute("call-3", {
			action: "update_status",
			id: createdTask.id,
			enabled: false,
		});
		expect(updateResult.details?.action).toBe("update_status");
		expect(updateResult.details?.task.enabled).toBe(false);

		watcher.recordExecution({
			taskId: createdTask.id,
			status: "success",
			output: "Resources normal",
		});

		const historyResult = await tool.execute("call-4", {
			action: "history",
			taskId: createdTask.id,
		});
		expect(historyResult.details?.action).toBe("history");
		expect(historyResult.details?.history.length).toBe(1);

		const clearResult = await tool.execute("call-5", {
			action: "clear_history",
			taskId: createdTask.id,
		});
		expect(clearResult.details?.action).toBe("clear_history");
		expect(clearResult.details?.cleared).toBe(1);

		const verifyHistory = await tool.execute("call-6", {
			action: "history",
		});
		expect(verifyHistory.details?.history.length).toBe(0);
	});
});
