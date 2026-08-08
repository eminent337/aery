/**
 * Cron Job Store (SQLite)
 * 
 * Persists cron jobs to the agent database.
 */

import { Database, type Statement } from "bun:sqlite";
import { Snowflake } from "@aryee337/aery-utils";
import { getAgentDbPath } from "@aryee337/aery-utils";
import type { CronJob, CronJobStore } from "./types.js";

/** SQLite row shape for cron_jobs table */
type CronJobRow = {
	id: string;
	schedule: string;
	session_id: string;
	delivery_mode: string;
	description: string | null;
	enabled: number;
	last_run_at: number | null;
	next_run_at: number | null;
	created_at: number;
	updated_at: number;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

export class SqliteCronJobStore implements CronJobStore {
	readonly #db: Database;
	/#listStmt: Statement;
	/#getStmt: Statement;
	/#insertStmt: Statement;
	/#updateStmt: Statement;
	/#deleteStmt: Statement;
	/#findDueStmt: Statement;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();
		this.#prepareStatements();
	}

	async list(): Promise<CronJob[]> {
		const rows = this.#listStmt.all() as CronJobRow[];
		return rows.map(row => this.#rowToJob(row));
	}

	async get(id: string): Promise<CronJob | undefined> {
		const rows = this.#getStmt.all(id) as CronJobRow[];
		return rows[0] ? this.#rowToJob(rows[0]) : undefined;
	}

	async create(job: Omit<CronJob, "id" | "createdAt" | "updatedAt" | "nextRunAt">): Promise<CronJob> {
		const now = Date.now();
		const id = String(Snowflake.next());
		const nextRunAt = this.#calculateNextRun(job.schedule);

		this.#insertStmt.run(
			id,
			job.schedule,
			job.sessionId,
			job.deliveryMode,
			job.description ?? null,
			job.enabled ? 1 : 0,
			null,
			nextRunAt,
			now,
			now,
		);

		return this.get(id) as Promise<CronJob>;
	}

	async update(id: string, updates: Partial<CronJob>): Promise<CronJob | undefined> {
		const existing = await this.get(id);
		if (!existing) return undefined;

		const now = Date.now();
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (updates.schedule !== undefined) {
			setClauses.push("schedule = ?");
			values.push(updates.schedule);
		}
		if (updates.sessionId !== undefined) {
			setClauses.push("session_id = ?");
			values.push(updates.sessionId);
		}
		if (updates.deliveryMode !== undefined) {
			setClauses.push("delivery_mode = ?");
			values.push(updates.deliveryMode);
		}
		if (updates.description !== undefined) {
			setClauses.push("description = ?");
			values.push(updates.description);
		}
		if (updates.enabled !== undefined) {
			setClauses.push("enabled = ?");
			values.push(updates.enabled ? 1 : 0);
		}
		if (updates.schedule !== undefined) {
			setClauses.push("next_run_at = ?");
			values.push(this.#calculateNextRun(updates.schedule));
		}

		setClauses.push("updated_at = ?");
		values.push(now);
		values.push(id);

		this.#updateStmt.run(...values);
		return this.get(id);
	}

	async delete(id: string): Promise<boolean> {
		const result = this.#deleteStmt.run(id);
		return result.changes > 0;
	}

	async findDue(beforeMs?: number): Promise<CronJob[]> {
		const now = Date.now();
		const cutoff = beforeMs ? now + beforeMs : now;
		const rows = this.#findDueStmt.all(cutoff) as CronJobRow[];
		return rows.map(row => this.#rowToJob(row));
	}

	/#initializeSchema(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS cron_jobs (
				id TEXT PRIMARY KEY,
				schedule TEXT NOT NULL,
				session_id TEXT NOT NULL,
				delivery_mode TEXT NOT NULL DEFAULT 'follow_up',
				description TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				last_run_at INTEGER,
				next_run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	/#prepareStatements(): void {
		this.#listStmt = this.#db.prepare(
			"SELECT * FROM cron_jobs ORDER BY created_at DESC"
		);
		this.#getStmt = this.#db.prepare(
			"SELECT * FROM cron_jobs WHERE id = ?"
		);
		this.#insertStmt = this.#db.prepare(`
			INSERT INTO cron_jobs (id, schedule, session_id, delivery_mode, description, enabled, last_run_at, next_run_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.#updateStmt = this.#db.prepare(`
			UPDATE cron_jobs SET
				schedule = COALESCE(?1, schedule),
				session_id = COALESCE(?2, session_id),
				delivery_mode = COALESCE(?3, delivery_mode),
				description = COALESCE(?4, description),
				enabled = COALESCE(?5, enabled),
				next_run_at = COALESCE(?6, next_run_at),
				updated_at = ?7
			WHERE id = ?8
		`);
		this.#deleteStmt = this.#db.prepare(
			"DELETE FROM cron_jobs WHERE id = ?"
		);
		this.#findDueStmt = this.#db.prepare(`
			SELECT * FROM cron_jobs
			WHERE enabled = 1 AND next_run_at <= ?
			ORDER BY next_run_at ASC
		`);
	}

	/#rowToJob(row: CronJobRow): CronJob {
		return {
			id: row.id,
			schedule: row.schedule,
			sessionId: row.session_id,
			deliveryMode: row.delivery_mode as "steer" | "follow_up",
			description: row.description ?? undefined,
			enabled: row.enabled === 1,
			lastRunAt: row.last_run_at ?? undefined,
			nextRunAt: row.next_run_at ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	/#calculateNextRun(schedule: string): number {
		// Simple implementation - in production, use a proper cron library
		const now = Date.now();
		// Default to 1 minute from now
		return now + 60_000;
	}
}

/**
 * Create a cron job store from an existing database.
 */
export function createCronJobStore(db: Database): CronJobStore {
	return new SqliteCronJobStore(db);
}
