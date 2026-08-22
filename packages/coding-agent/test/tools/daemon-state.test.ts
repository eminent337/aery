import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DaemonRecord,
	isPidAlive,
	isSafeStatePath,
	listDaemons,
	makeDaemonId,
	readDaemon,
	registerDaemon,
	unregisterDaemon,
	validateDaemonName,
} from "../../src/tools/daemon-state";

describe("validateDaemonName", () => {
	it("accepts valid names", () => {
		expect(validateDaemonName("my-server")).toBeUndefined();
		expect(validateDaemonName("dev_web")).toBeUndefined();
		expect(validateDaemonName("a")).toBeUndefined();
		expect(validateDaemonName("a".repeat(40))).toBeUndefined();
	});

	it("rejects empty names", () => {
		expect(validateDaemonName("")).toBe("Daemon name cannot be empty (omit the parameter for the default name).");
	});

	it("rejects names that are too long", () => {
		expect(validateDaemonName("a".repeat(41))).toBe("Daemon name too long (max 40 chars).");
	});

	it("rejects names with invalid chars", () => {
		expect(validateDaemonName("my server")).toContain("may only contain");
		expect(validateDaemonName("my.server")).toContain("may only contain");
		expect(validateDaemonName("my/server")).toContain("may only contain");
	});
});

describe("makeDaemonId", () => {
	it("uses name prefix when provided", () => {
		const id = makeDaemonId("my-server");
		expect(id.startsWith("my-server-")).toBe(true);
		expect(id.length).toBe("my-server-".length + 6);
	});

	it("uses 'daemon' prefix when no name", () => {
		const id = makeDaemonId(undefined);
		expect(id.startsWith("daemon-")).toBe(true);
	});
});

describe("isSafeStatePath", () => {
	it("accepts paths inside the state dir", () => {
		expect(isSafeStatePath("/data/daemons", "/data/daemons/foo.json")).toBe(true);
		expect(isSafeStatePath("/data/daemons", "/data/daemons/sub/foo.log")).toBe(true);
	});

	it("rejects paths outside the state dir", () => {
		expect(isSafeStatePath("/data/daemons", "/etc/passwd")).toBe(false);
		expect(isSafeStatePath("/data/daemons", "/data/other/foo.json")).toBe(false);
		expect(isSafeStatePath("/data/daemons", "relative/path")).toBe(false);
	});
});

describe("isPidAlive", () => {
	it("reports the current process as alive", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("reports a non-existent pid as dead", () => {
		expect(isPidAlive(99999999)).toBe(false);
	});
});

describe("daemon state management", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "daemon-state-"));
	});

	afterEach(() => {
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	function makeRecord(id: string, pid: number): DaemonRecord {
		return {
			id,
			pid,
			command: "sleep 3600",
			cwd: "/tmp",
			name: "test",
			startedAt: new Date().toISOString(),
			logFile: join(stateDir, `${id}.log`),
			pidFile: join(stateDir, `${id}.pid`),
		};
	}

	it("registers and reads a daemon record", () => {
		const record = makeRecord("test-abc123", 12345);
		registerDaemon(stateDir, record);

		const read = readDaemon(stateDir, "test-abc123");
		expect(read).toEqual(record);
	});

	it("returns undefined for missing records", () => {
		expect(readDaemon(stateDir, "nonexistent")).toBeUndefined();
	});

	it("unregisters a daemon record", () => {
		const record = makeRecord("test-abc123", 12345);
		registerDaemon(stateDir, record);
		unregisterDaemon(stateDir, "test-abc123");
		expect(readDaemon(stateDir, "test-abc123")).toBeUndefined();
	});

	it("lists live daemons and prunes dead ones", () => {
		const liveRecord = makeRecord("live-abc123", process.pid);
		const deadRecord = makeRecord("dead-abc123", 99999999);
		registerDaemon(stateDir, liveRecord);
		registerDaemon(stateDir, deadRecord);

		const list = listDaemons(stateDir);
		expect(list.length).toBe(1);
		expect(list[0]?.record.id).toBe("live-abc123");
		expect(list[0]?.alive).toBe(true);

		// Dead record should be pruned
		expect(readDaemon(stateDir, "dead-abc123")).toBeUndefined();
	});

	it("rejects records with invalid pid", () => {
		const record = makeRecord("bad-abc123", -1);
		registerDaemon(stateDir, record);
		expect(readDaemon(stateDir, "bad-abc123")).toBeUndefined();
	});

	it("rejects records with id mismatch", () => {
		const record = makeRecord("file-abc123", 12345);
		registerDaemon(stateDir, record);
		// Manually tamper with the record
		const { readDaemon: _readDaemon } = require("../../src/tools/daemon-state");
		const path = join(stateDir, "file-abc123.json");
		const tampered = { ...record, id: "tampered" };
		require("node:fs").writeFileSync(path, JSON.stringify(tampered));
		expect(readDaemon(stateDir, "file-abc123")).toBeUndefined();
	});
});
