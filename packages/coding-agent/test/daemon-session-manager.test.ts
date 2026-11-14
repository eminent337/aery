import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	findBackgroundSession,
	isProcessAlive,
	listBackgroundSessions,
	readBackgroundSessionLogs,
	registerBackgroundSession,
	removeBackgroundSession,
	stopBackgroundSession,
} from "../src/cli/daemon-session-manager";

describe("Daemon Session Manager", () => {
	it("should detect current process as alive and non-existent pid as not alive", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(99999999)).toBe(false);
	});

	it("should register, find, list, and remove a background session", async () => {
		const testId = `test-${Date.now()}`;
		const dummyLog = path.join(os.tmpdir(), `${testId}.log`);
		await fs.writeFile(dummyLog, "line 1\nline 2\nline 3\n", "utf-8");

		// Spawn a short-lived sleeper process so we have a real alive PID
		const sleeper = Bun.spawn(["sleep", "60"]);

		try {
			await registerBackgroundSession({
				id: testId,
				pid: sleeper.pid,
				cwd: process.cwd(),
				command: "sleep 60",
				startedAt: new Date().toISOString(),
				logFile: dummyLog,
			});

			const found = await findBackgroundSession(testId);
			expect(found).toBeDefined();
			expect(found?.id).toBe(testId);
			expect(found?.status).toBe("running");

			const all = await listBackgroundSessions();
			expect(all.some(s => s.id === testId)).toBe(true);

			const logs = await readBackgroundSessionLogs(testId, 2);
			expect(logs).toContain("line 2");
			expect(logs).toContain("line 3");

			const stopped = await stopBackgroundSession(testId);
			expect(stopped).toBe(true);

			const afterStop = await findBackgroundSession(testId);
			expect(afterStop?.status).toBe("stopped");

			const removed = await removeBackgroundSession(testId);
			expect(removed).toBe(true);

			const afterRemove = await findBackgroundSession(testId);
			expect(afterRemove).toBeUndefined();
		} finally {
			try {
				sleeper.kill();
			} catch {}
		}
	});
});
