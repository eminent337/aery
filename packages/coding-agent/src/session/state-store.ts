import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@aryee337/aery-utils";

/** Represents a JSON snapshot of an AgentSession for crash-recovery */
export interface PersistedSessionState {
	sessionId: string;
	status: "running" | "paused" | "completed" | "crashed";
	snapshot: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface SessionPruningOptions {
	/** Maximum number of completed sessions to retain (default: 10). */
	maxCompleted?: number;
	/** Maximum number of crashed sessions to retain (default: 20). */
	maxCrashed?: number;
	/** Maximum age in seconds for retaining completed/crashed sessions (default: 7 days). */
	maxAgeSeconds?: number;
}

const instances = new Map<string, SessionStateStore>();

/**
 * A typed JSON/snapshot store for interrupt/resume of agent sessions.
 * Mirrors the pattern established by FermentStore.
 */
export class SessionStateStore {
	#db: Database;

	private constructor(db: Database) {
		this.#db = db;
	}

	#initializeSchema(): void {
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS session_states (
				session_id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER,
				updated_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_session_states_status_updated ON session_states (status, updated_at DESC);
		`);
	}

	getJournalMode(): string {
		const row = this.#db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
		return row?.journal_mode ?? "delete";
	}

	vacuum(): void {
		try {
			this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
		} catch (err) {
			logger.warn("SessionStateStore failed to vacuum database", { error: String(err) });
		}
	}

	pruneStaleSessions(options: SessionPruningOptions = {}): number {
		const maxCompleted = options.maxCompleted ?? 10;
		const maxCrashed = options.maxCrashed ?? 20;
		const maxAgeSeconds = options.maxAgeSeconds ?? 86400 * 7;
		const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;

		let prunedCount = 0;

		// 1. Delete completed and crashed sessions older than cutoff
		const ageResult = this.#db
			.prepare("DELETE FROM session_states WHERE status IN ('completed', 'crashed') AND updated_at < ?")
			.run(cutoff);
		prunedCount += ageResult.changes;

		// 2. Prune excess completed sessions beyond maxCompleted
		if (maxCompleted >= 0) {
			const excessCompleted = this.#db
				.prepare(`
					DELETE FROM session_states
					WHERE status = 'completed'
					AND session_id NOT IN (
						SELECT session_id FROM session_states
						WHERE status = 'completed'
						ORDER BY updated_at DESC
						LIMIT ?
					)
				`)
				.run(maxCompleted);
			prunedCount += excessCompleted.changes;
		}

		// 3. Prune excess crashed sessions beyond maxCrashed
		if (maxCrashed >= 0) {
			const excessCrashed = this.#db
				.prepare(`
					DELETE FROM session_states
					WHERE status = 'crashed'
					AND session_id NOT IN (
						SELECT session_id FROM session_states
						WHERE status = 'crashed'
						ORDER BY updated_at DESC
						LIMIT ?
					)
				`)
				.run(maxCrashed);
			prunedCount += excessCrashed.changes;
		}

		return prunedCount;
	}

	static open(dbPath?: string): SessionStateStore {
		const resolved = dbPath ?? getAgentDbPath();
		const storePath = path.join(path.dirname(resolved), "session_state.db");

		const existing = instances.get(storePath);
		if (existing) return existing;

		const dir = path.dirname(storePath);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw new Error(`Failed to create SessionStateStore directory: ${code || String(err)}`);
			}
		}

		const db = new Database(storePath);
		const store = new SessionStateStore(db);
		store.#initializeSchema();
		instances.set(storePath, store);
		return store;
	}

	save(state: PersistedSessionState): void {
		const now = Math.floor(Date.now() / 1000);
		if (!state.updatedAt) state.updatedAt = now;
		if (!state.createdAt) state.createdAt = now;

		this.#db
			.prepare(
				`INSERT INTO session_states (session_id, data, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
			   data = excluded.data,
			   status = excluded.status,
			   updated_at = excluded.updated_at`,
			)
			.run(state.sessionId, JSON.stringify(state), state.status, state.createdAt, state.updatedAt);
	}

	get(sessionId: string): PersistedSessionState | null {
		const row = this.#db.prepare("SELECT data FROM session_states WHERE session_id = ?").get(sessionId) as
			| { data: string }
			| undefined;
		if (!row) return null;

		try {
			return JSON.parse(row.data) as PersistedSessionState;
		} catch (err) {
			logger.warn("SessionStateStore failed to parse session data", { sessionId, error: String(err) });
			return null;
		}
	}

	listByStatus(status: string): PersistedSessionState[] {
		const rows = this.#db.prepare("SELECT data FROM session_states WHERE status = ?").all(status) as Array<{
			data: string;
		}>;
		const states: PersistedSessionState[] = [];
		for (const row of rows) {
			try {
				states.push(JSON.parse(row.data) as PersistedSessionState);
			} catch (err) {
				logger.warn("SessionStateStore failed to parse session state in listByStatus", { error: String(err) });
			}
		}
		return states;
	}

	delete(sessionId: string): void {
		this.#db.prepare("DELETE FROM session_states WHERE session_id = ?").run(sessionId);
	}
}
