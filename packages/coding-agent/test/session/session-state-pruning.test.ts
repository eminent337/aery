import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setAgentDir } from "@aryee337/aery-utils";
import { recoverStrandedSessions } from "../../src/session/recovery";
import { SessionStateStore } from "../../src/session/state-store";

let testDir = path.join("/tmp", `session-pruning-test-${Math.random().toString(36).slice(2)}`);

describe("SessionStateStore AGY-style retention & pruning", () => {
	beforeEach(() => {
		testDir = path.join("/tmp", `session-pruning-test-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		setAgentDir(testDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test("initializes with WAL journal mode and status index", () => {
		const store = SessionStateStore.open();
		const journalMode = store.getJournalMode();
		expect(journalMode.toLowerCase()).toBe("wal");
	});

	test("prunes completed sessions exceeding retention limit", () => {
		const store = SessionStateStore.open();
		const now = Math.floor(Date.now() / 1000);

		// Insert 10 completed sessions with different timestamps
		for (let i = 0; i < 10; i++) {
			store.save({
				sessionId: `completed-${i}`,
				status: "completed",
				snapshot: { index: i },
				createdAt: now - (100 - i),
				updatedAt: now - (100 - i),
			});
		}

		expect(store.listByStatus("completed").length).toBe(10);

		// Prune to keep only 3 completed sessions
		const pruned = store.pruneStaleSessions({ maxCompleted: 3 });
		expect(pruned).toBe(7);

		const remaining = store.listByStatus("completed");
		expect(remaining.length).toBe(3);
		// The 3 newest should be kept (index 7, 8, 9)
		const ids = remaining.map(s => s.sessionId);
		expect(ids).toContain("completed-7");
		expect(ids).toContain("completed-8");
		expect(ids).toContain("completed-9");
	});

	test("prunes crashed sessions exceeding retention limit and age", () => {
		const store = SessionStateStore.open();
		const now = Math.floor(Date.now() / 1000);

		// Insert 5 recent crashed sessions and 5 very old crashed sessions
		for (let i = 0; i < 5; i++) {
			store.save({
				sessionId: `crashed-old-${i}`,
				status: "crashed",
				snapshot: { old: true },
				createdAt: now - 86400 * 30, // 30 days old
				updatedAt: now - 86400 * 30,
			});
		}

		for (let i = 0; i < 5; i++) {
			store.save({
				sessionId: `crashed-new-${i}`,
				status: "crashed",
				snapshot: { old: false },
				createdAt: now - (50 - i),
				updatedAt: now - (50 - i),
			});
		}

		expect(store.listByStatus("crashed").length).toBe(10);

		// Prune with 7 day max age and max 3 crashed
		const pruned = store.pruneStaleSessions({ maxCrashed: 3, maxAgeSeconds: 86400 * 7 });
		expect(pruned).toBe(7); // 5 old + 2 newer pruned

		const remaining = store.listByStatus("crashed");
		expect(remaining.length).toBe(3);
		expect(remaining.map(s => s.sessionId)).toEqual(
			expect.arrayContaining(["crashed-new-2", "crashed-new-3", "crashed-new-4"]),
		);
	});

	test("vacuum runs without error", () => {
		const store = SessionStateStore.open();
		expect(() => store.vacuum()).not.toThrow();
	});

	test("recoverStrandedSessions automatically runs pruning on startup", () => {
		const store = SessionStateStore.open();
		const now = Math.floor(Date.now() / 1000);

		// Add 50 completed sessions
		for (let i = 0; i < 50; i++) {
			store.save({
				sessionId: `session-${i}`,
				status: "completed",
				snapshot: {},
				createdAt: now - (100 - i),
				updatedAt: now - (100 - i),
			});
		}

		recoverStrandedSessions();

		// Should have pruned to default limit (e.g. 10)
		const completed = store.listByStatus("completed");
		expect(completed.length).toBeLessThanOrEqual(10);
	});
});
