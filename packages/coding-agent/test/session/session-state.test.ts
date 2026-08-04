import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setAgentDir } from "@aryee337/aery-utils";
import { recoverStrandedSessions } from "../../src/session/recovery";
import { SessionStateStore } from "../../src/session/state-store";
import { createTestSession } from "../utilities";

let testDir = path.join("/tmp", `session-state-test-${Math.random().toString(36).slice(2)}`);

describe("SessionStateStore + recovery", () => {
	beforeEach(() => {
		testDir = path.join("/tmp", `session-state-test-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		// Redirect the agent DB (and thus SessionStateStore's default path)
		// into a fresh temp dir so tests never touch the real ~/.aery/agent DB.
		setAgentDir(testDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test("round-trips a running session state", () => {
		SessionStateStore.open().save({
			sessionId: "session-1",
			status: "running",
			snapshot: { agentId: "main", mode: "standard", cwd: testDir },
			createdAt: 0,
			updatedAt: 0,
		});

		const loaded = SessionStateStore.open().get("session-1");
		expect(loaded).not.toBeNull();
		expect(loaded!.status).toBe("running");
		expect(loaded!.snapshot.cwd).toBe(testDir);
	});

	test("recoverStrandedSessions marks stranded running sessions as crashed", () => {
		SessionStateStore.open().save({
			sessionId: "session-stranded",
			status: "running",
			snapshot: {},
			createdAt: 0,
			updatedAt: 0,
		});

		recoverStrandedSessions();

		expect(SessionStateStore.open().get("session-stranded")?.status).toBe("crashed");
	});

	test("recoverStrandedSessions leaves non-running sessions untouched", () => {
		SessionStateStore.open().save({
			sessionId: "session-completed",
			status: "completed",
			snapshot: {},
			createdAt: 0,
			updatedAt: 0,
		});

		recoverStrandedSessions();

		expect(SessionStateStore.open().get("session-completed")?.status).toBe("completed");
	});
});

describe("AgentSession lifecycle persistence", () => {
	test("constructor writes running and dispose writes completed", async () => {
		testDir = path.join("/tmp", `session-state-test-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		setAgentDir(testDir);

		try {
			const { sessionManager, cleanup } = await createTestSession({ inMemory: true });

			// Constructor should have persisted "running".
			const running = SessionStateStore.open().get(sessionManager.getSessionId());
			expect(running).not.toBeNull();
			expect(running!.status).toBe("running");

			await cleanup(); // calls session.dispose()

			// Dispose should have persisted "completed".
			const completed = SessionStateStore.open().get(sessionManager.getSessionId());
			expect(completed).not.toBeNull();
			expect(completed!.status).toBe("completed");
		} finally {
			try {
				fs.rmSync(testDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});
});
