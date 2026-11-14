import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@aryee337/aery-utils";

export interface BackgroundSessionInfo {
	id: string;
	pid: number;
	cwd: string;
	command: string;
	status: "running" | "stopped" | "exited";
	startedAt: string;
	logFile: string;
}

function getBackgroundDir(): string {
	return path.join(getSessionsDir(), "background");
}

function getManifestPath(): string {
	return path.join(getBackgroundDir(), "manifest.json");
}

async function loadManifest(): Promise<BackgroundSessionInfo[]> {
	try {
		const raw = await fs.readFile(getManifestPath(), "utf-8");
		return JSON.parse(raw) as BackgroundSessionInfo[];
	} catch (err) {
		if (isEnoent(err)) return [];
		return [];
	}
}

async function saveManifest(sessions: BackgroundSessionInfo[]): Promise<void> {
	const dir = getBackgroundDir();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(getManifestPath(), JSON.stringify(sessions, null, 2), "utf-8");
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function listBackgroundSessions(filterCwd?: string): Promise<BackgroundSessionInfo[]> {
	const sessions = await loadManifest();
	let modified = false;

	for (const s of sessions) {
		if (s.status === "running") {
			if (!isProcessAlive(s.pid)) {
				s.status = "exited";
				modified = true;
			}
		}
	}

	if (modified) {
		await saveManifest(sessions);
	}

	if (filterCwd) {
		return sessions.filter(s => s.cwd === filterCwd);
	}
	return sessions;
}

export async function findBackgroundSession(idOrPrefix: string): Promise<BackgroundSessionInfo | undefined> {
	const sessions = await listBackgroundSessions();
	const exact = sessions.find(s => s.id === idOrPrefix);
	if (exact) return exact;
	return sessions.find(s => s.id.startsWith(idOrPrefix));
}

export async function registerBackgroundSession(entry: Omit<BackgroundSessionInfo, "status">): Promise<void> {
	const sessions = await loadManifest();
	const newEntry: BackgroundSessionInfo = {
		...entry,
		status: "running",
	};
	sessions.unshift(newEntry);
	await saveManifest(sessions);
}

export async function stopBackgroundSession(idOrPrefix: string): Promise<boolean> {
	const session = await findBackgroundSession(idOrPrefix);
	if (!session) return false;

	if (session.status === "running" && isProcessAlive(session.pid)) {
		try {
			process.kill(session.pid, "SIGTERM");
		} catch {}
	}
	session.status = "stopped";

	const sessions = await loadManifest();
	const target = sessions.find(s => s.id === session.id);
	if (target) {
		target.status = "stopped";
		await saveManifest(sessions);
	}
	return true;
}

export async function removeBackgroundSession(idOrPrefix: string): Promise<boolean> {
	const sessions = await loadManifest();
	const session = sessions.find(s => s.id === idOrPrefix || s.id.startsWith(idOrPrefix));
	if (!session) return false;

	if (session.status === "running" && isProcessAlive(session.pid)) {
		try {
			process.kill(session.pid, "SIGKILL");
		} catch {}
	}

	const updated = sessions.filter(s => s.id !== session.id);
	await saveManifest(updated);

	// Try removing log file
	try {
		await fs.rm(session.logFile, { force: true });
	} catch {}

	return true;
}

export async function readBackgroundSessionLogs(idOrPrefix: string, linesCount = 50): Promise<string> {
	const session = await findBackgroundSession(idOrPrefix);
	if (!session) {
		throw new Error(`Background session not found: ${idOrPrefix}`);
	}

	try {
		const raw = await fs.readFile(session.logFile, "utf-8");
		const lines = raw.trimEnd().split("\n");
		return lines.slice(-linesCount).join("\n");
	} catch (err) {
		if (isEnoent(err)) {
			return "(No log output recorded yet)";
		}
		throw err;
	}
}
