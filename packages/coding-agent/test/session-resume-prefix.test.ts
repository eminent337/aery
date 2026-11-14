import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveResumableSession } from "../src/session/session-manager";

describe("Fast Prefix Resumption (AGY 1.5.9 Parity)", () => {
	let testDir: string;
	let sessionDir: string;

	beforeEach(async () => {
		testDir = path.join(os.tmpdir(), `aery-resume-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		sessionDir = path.join(testDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	async function createMockSession(id: string, time: number) {
		const filePath = path.join(sessionDir, `${time}_${id}.jsonl`);
		const header = {
			type: "session",
			id,
			timestamp: time,
			cwd: testDir,
		};
		await fs.writeFile(filePath, `${JSON.stringify(header)}\n`, "utf8");
	}

	it("resolves session when prefix matches exactly one session", async () => {
		await createMockSession("abc123unique", 1000);
		await createMockSession("xyz999other", 2000);

		const match = await resolveResumableSession("abc12", testDir, sessionDir);
		expect(match).toBeDefined();
		expect(match?.session.id).toBe("abc123unique");
	});

	it("rejects ambiguous prefix matching multiple sessions", async () => {
		await createMockSession("task-alpha-1", 1000);
		await createMockSession("task-alpha-2", 2000);

		await expect(resolveResumableSession("task-alpha", testDir, sessionDir)).rejects.toThrow(
			"Ambiguous session prefix",
		);
	});

	it("returns undefined when prefix matches no session", async () => {
		await createMockSession("task-beta-1", 1000);

		const match = await resolveResumableSession("nonexistent", testDir, sessionDir);
		expect(match).toBeUndefined();
	});
});
