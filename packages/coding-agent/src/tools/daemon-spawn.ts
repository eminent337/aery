/**
 * Detached daemon spawn + stop.
 *
 * Lifecycle contract: a daemon spawned here OUTLIVES the Aery session.
 * It escapes every kill chain the harness has by using `detached: true`
 * + `unref()` + `exec bash -c` wrapping.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { daemonStateDir, isPidAlive, makeDaemonId, registerDaemon, unregisterDaemon } from "./daemon-state";
import type { DaemonRecord } from "./daemon-state";

const CRASH_GRACE_MS = 500;
const STOP_TERM_GRACE_MS = 2000;
const STOP_KILL_GRACE_MS = 1000;
const SHELL = process.platform === "win32" ? "cmd.exe" : "bash";
const shellArgs = (cmd: string): string[] => (process.platform === "win32" ? ["/c", cmd] : ["-c", cmd]);

export interface SpawnDaemonOptions {
	command: string;
	cwd: string;
	name?: string;
	stateDir?: string;
	crashGraceMs?: number;
}

export type SpawnDaemonOutcome = { ok: true; record: DaemonRecord } | { ok: false; error: string };

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * POSIX-safe single-quote escaping. Double-quote interpolation
 * (JSON.stringify) is NOT safe for shell embedding: the outer shell
 * expands $vars/backticks/$(…) inside double quotes before the inner
 * bash receives them.
 */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Read the last `maxBytes` of a log file (or undefined when absent).
 * Seeks to the tail rather than loading the whole file.
 */
export function readLogTail(logFile: string, maxBytes = 8192): string | undefined {
	if (!existsSync(logFile)) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(logFile, "r");
		const size = fstatSync(fd).size;
		const from = Math.max(0, size - maxBytes);
		const length = size - from;
		if (length <= 0) return "";
		const buf = Buffer.alloc(length);
		readSync(fd, buf, 0, length, from);
		let slice = buf;
		let start = 0;
		while (start < slice.length && (slice[start] & 0xc0) === 0x80) start++;
		if (start > 0) slice = slice.subarray(start);
		return slice.toString("utf8");
	} catch (err) {
		console.error(`daemon: failed to read log ${logFile}:`, err);
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<SpawnDaemonOutcome> {
	const { command, cwd, name } = opts;
	const stateDir = opts.stateDir ?? daemonStateDir();
	if (command.trim().length === 0) {
		return { ok: false, error: "Empty command — nothing to daemonize." };
	}
	const id = makeDaemonId(name);
	const logFile = `${stateDir}/${id}.log`;
	const pidFile = `${stateDir}/${id}.pid`;

	const wrapped =
		process.platform === "win32"
			? `${command} >> "${logFile}" 2>&1`
			: `exec bash -c ${shellQuote(command)} >> ${shellQuote(logFile)} 2>&1`;

	const child = spawn(SHELL, shellArgs(wrapped), {
		cwd,
		env: process.env,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});

	let spawnError: Error | undefined;
	child.on("error", err => {
		spawnError = err;
	});
	child.unref();

	if (child.pid === undefined) {
		return { ok: false, error: `Failed to spawn daemon: ${spawnError?.message ?? "no pid assigned"}.` };
	}

	const record: DaemonRecord = {
		id,
		pid: child.pid,
		command,
		cwd,
		name,
		startedAt: new Date().toISOString(),
		logFile,
		pidFile,
	};
	registerDaemon(stateDir, record);

	const grace = opts.crashGraceMs ?? CRASH_GRACE_MS;
	if (grace > 0) await sleep(grace);
	if (!isPidAlive(child.pid)) {
		const tail = readLogTail(logFile, 2048);
		unregisterDaemon(stateDir, id);
		const reason = spawnError
			? `Spawn failed: ${spawnError.message}`
			: `Daemon ${id} (pid ${child.pid}) exited immediately. The command probably failed at startup.`;
		return {
			ok: false,
			error: reason + (tail ? `\n\n--- last output ---\n${tail.trimEnd()}` : ""),
		};
	}

	return { ok: true, record };
}

/**
 * Stop a daemon: SIGTERM the process group, grace, then SIGKILL. The
 * daemon is a process-group leader (spawned detached), so -pid reaches
 * the whole tree. Idempotent: a dead pid is reported, not an error.
 */
export async function stopDaemon(record: DaemonRecord, stateDir: string): Promise<{ stopped: boolean; note: string }> {
	const { pid } = record;
	if (!isPidAlive(pid)) {
		unregisterDaemon(stateDir, record.id);
		return { stopped: false, note: `Daemon ${record.id} (pid ${pid}) was already not running. Record cleaned up.` };
	}

	if (process.platform === "win32") {
		spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
	} else {
		try {
			process.kill(-pid, "SIGTERM");
		} catch (err) {
			console.error(`daemon: SIGTERM to group -${pid} failed:`, err);
		}
		const deadline = Date.now() + STOP_TERM_GRACE_MS;
		while (isPidAlive(pid) && Date.now() < deadline) {
			await sleep(100);
		}
		if (isPidAlive(pid)) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch (err) {
				console.error(`daemon: SIGKILL to group -${pid} failed:`, err);
			}
			const killDeadline = Date.now() + STOP_KILL_GRACE_MS;
			while (isPidAlive(pid) && Date.now() < killDeadline) {
				await sleep(50);
			}
		}
	}

	const stillAlive = isPidAlive(pid);
	if (stillAlive) {
		return {
			stopped: false,
			note: `Sent SIGKILL to daemon ${record.id} (pid ${pid}) but it is still alive — manual intervention needed.`,
		};
	}
	unregisterDaemon(stateDir, record.id);
	return { stopped: true, note: `Daemon ${record.id} (pid ${pid}) stopped. Log kept at ${record.logFile}.` };
}
