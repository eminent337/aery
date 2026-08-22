import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogTail, spawnDaemon, stopDaemon } from "../../src/tools/daemon-spawn";
import type { DaemonRecord } from "../../src/tools/daemon-state";
import { isPidAlive, makeDaemonId, registerDaemon } from "../../src/tools/daemon-state";

describe("spawnDaemon", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "daemon-spawn-"));
	});

	afterEach(() => {
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("spawns a detached long-lived process", async () => {
		const outcome = await spawnDaemon({
			command: "sleep 3600",
			cwd: stateDir,
			name: "test-sleeper",
			stateDir,
			crashGraceMs: 300,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const { record } = outcome;
		expect(record.id.startsWith("test-sleeper-")).toBe(true);
		expect(record.pid).toBeGreaterThan(0);
		expect(isPidAlive(record.pid)).toBe(true);
		expect(record.command).toBe("sleep 3600");

		// Cleanup
		const { stopped } = await stopDaemon(record, stateDir);
		expect(stopped).toBe(true);
	});

	it("rejects empty commands", async () => {
		const outcome = await spawnDaemon({
			command: "   ",
			cwd: stateDir,
			stateDir,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("Empty command");
	});

	it("reports a crashing daemon with log tail", async () => {
		const outcome = await spawnDaemon({
			command: "echo 'startup failed' && exit 1",
			cwd: stateDir,
			name: "crasher",
			stateDir,
			crashGraceMs: 200,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("exited immediately");
		expect(outcome.error).toContain("startup failed");
	});

	it("redirects command output to the log file", async () => {
		const outcome = await spawnDaemon({
			command: "echo 'hello daemon' && sleep 3600",
			cwd: stateDir,
			name: "logger",
			stateDir,
			crashGraceMs: 500,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const { record } = outcome;

		// Give the echo a moment to flush
		await new Promise(resolve => setTimeout(resolve, 200));
		const tail = readLogTail(record.logFile);
		expect(tail).toContain("hello daemon");

		await stopDaemon(record, stateDir);
	});
});

describe("stopDaemon", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "daemon-stop-"));
	});

	afterEach(() => {
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("stops a running daemon by process group", async () => {
		const outcome = await spawnDaemon({
			command: "sleep 3600",
			cwd: stateDir,
			name: "stop-me",
			stateDir,
			crashGraceMs: 300,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const { record } = outcome;
		const pid = record.pid;
		expect(isPidAlive(pid)).toBe(true);

		const { stopped, note } = await stopDaemon(record, stateDir);
		expect(stopped).toBe(true);
		expect(note).toContain("stopped");
		expect(isPidAlive(pid)).toBe(false);
	});

	it("is idempotent for already-dead daemons", async () => {
		const id = makeDaemonId("ghost");
		const record: DaemonRecord = {
			id,
			pid: 99999999,
			command: "ghost",
			cwd: stateDir,
			startedAt: new Date().toISOString(),
			logFile: join(stateDir, `${id}.log`),
			pidFile: join(stateDir, `${id}.pid`),
		};
		registerDaemon(stateDir, record);

		const { stopped, note } = await stopDaemon(record, stateDir);
		expect(stopped).toBe(false);
		expect(note).toContain("already not running");
	});
});
