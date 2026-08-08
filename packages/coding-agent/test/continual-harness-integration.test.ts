import { describe, expect, it, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionHarnessHost } from "../src/continual-harness/state.js";
import { ContinualHarnessEngine, createContinualHarnessEngine } from "../src/continual-harness/engine.js";
import { getGlobalCronScheduler } from "../src/cron/scheduler.js";

describe("Continual Harness Integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-int-test-"));
	});

	it("should initialize session harness host and merge global and local states", async () => {
		const mockSessionManager: any = {
			sessionFile: path.join(tmpDir, "sessions", "test-session.jsonl"),
			getBranch: () => [
				{ message: { role: "user", content: "Implement feature X" } },
				{ message: { role: "assistant", content: "I will write the code." } },
			],
		};

		const host = createSessionHarnessHost(mockSessionManager, tmpDir);
		const state = await host.getHarnessState();

		expect(state).toBeDefined();
		expect(state.schema).toBe(1);
		expect(state.entries).toBeDefined();
		expect(state.entries.prompt).toEqual({});

		const trajectory = await host.getTrajectory();
		expect(trajectory).toContain("USER: Implement feature X");
		expect(trajectory).toContain("ASSISTANT: I will write the code.");
	});

	it("should manipulate harness state entries cleanly", async () => {
		const mockSessionManager: any = {
			sessionFile: path.join(tmpDir, "sessions", "test-session.jsonl"),
			getBranch: () => [],
		};

		const host = createSessionHarnessHost(mockSessionManager, tmpDir);
		const engine = createContinualHarnessEngine(host);

		const initialStatus = await host.getHarnessState();
		expect(initialStatus.entries.memory).toEqual({});

		const history = await host.getRefinementHistory();
		expect(Array.isArray(history)).toBe(true);
	});

	it("should manage cron jobs via global cron scheduler", async () => {
		const scheduler = getGlobalCronScheduler();
		expect(scheduler).toBeDefined();
		expect(scheduler.isRunning).toBe(true);

		const created = await scheduler.store.create({
			schedule: "every 5m",
			sessionId: "test-sess-123",
			deliveryMode: "follow_up",
			enabled: true,
		});

		expect(created.id).toBeDefined();
		expect(created.schedule).toBe("every 5m");

		const fetched = await scheduler.store.get(created.id);
		expect(fetched).toBeDefined();
		expect(fetched?.sessionId).toBe("test-sess-123");

		const deleted = await scheduler.store.delete(created.id);
		expect(deleted).toBe(true);
	});
});
