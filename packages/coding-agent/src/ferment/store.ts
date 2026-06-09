import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@aryee337/aery-utils";

import type { Ferment } from "./types.js";

export interface FermentEvent {
	id?: number;
	fermentId: string;
	eventType: string;
	eventData?: Record<string, unknown>;
	createdAt?: string;
}

/** Singleton instances per DB path */
const instances = new Map<string, FermentStore>();

export class FermentStore {
	#db: Database;
	#cache = new Map<string, Ferment>();

	private constructor(db: Database) {
		this.#db = db;
	}

	#initializeSchema(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS ferments (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				status TEXT NOT NULL,
				worktree_path TEXT,
				active_phase_id TEXT,
				created_at INTEGER,
				updated_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS ferment_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ferment_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				event_data TEXT,
				created_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_ferment_events_id ON ferment_events(ferment_id);
		`);
	}

	/**
	 * Open (or create) a FermentStore singleton for the given DB path.
	 * @param dbPath - Path to the agent SQLite DB. Defaults to the agent config path.
	 */
	static open(dbPath?: string): FermentStore {
		const resolved = dbPath ?? getAgentDbPath();
		const existing = instances.get(resolved);
		if (existing) return existing;

		// Ensure the store directory exists
		const dir = path.dirname(resolved);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw new Error(`Failed to create FermentStore directory '${dir}': ${code || String(err)}`);
			}
		}

		const db = new Database(resolved);
		const store = new FermentStore(db);
		store.#initializeSchema();
		instances.set(resolved, store);
		return store;
	}

	/** Load a ferment by ID. Checks cache first, falls back to DB. */
	get(id: string): Ferment | null {
		const cached = this.#cache.get(id);
		if (cached) return cached;

		const row = this.#db.prepare("SELECT data FROM ferments WHERE id = ?").get(id) as { data: string } | undefined;
		if (!row) return null;

		try {
			const ferment = JSON.parse(row.data) as Ferment;
			this.#cache.set(id, ferment);
			return ferment;
		} catch (err) {
			logger.warn("FermentStore failed to parse ferment data", { id, error: String(err) });
			return null;
		}
	}

	/**
	 * Save a ferment blob atomically, optionally appending events in the same transaction.
	 * Updates both DB and in-memory cache.
	 */
	save(ferment: Ferment, events?: FermentEvent[]): void {
		const now = Math.floor(Date.now() / 1000);
		const data = JSON.stringify(ferment);
		const status = ferment.status;
		const worktreePath = ferment.worktree?.path ?? null;
		const activePhaseId = ferment.activePhaseId ?? null;

		const tx = this.#db.transaction(() => {
			this.#db
				.prepare(
					`INSERT INTO ferments (id, data, status, worktree_path, active_phase_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             status = excluded.status,
             worktree_path = excluded.worktree_path,
             active_phase_id = excluded.active_phase_id,
             updated_at = excluded.updated_at`,
				)
				.run(ferment.id, data, status, worktreePath, activePhaseId, now, now);

			if (events && events.length > 0) {
				const insertEvent = this.#db.prepare(
					`INSERT INTO ferment_events (ferment_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?)`,
				);
				for (const evt of events) {
					insertEvent.run(
						evt.fermentId,
						evt.eventType,
						evt.eventData ? JSON.stringify(evt.eventData) : null,
						evt.createdAt ? Math.floor(new Date(evt.createdAt).getTime() / 1000) : now,
					);
				}
			}
		});

		tx();
		this.#cache.set(ferment.id, ferment);
	}

	/** List all ferments for a worktree path. */
	listByWorktree(worktreePath: string): Ferment[] {
		const rows = this.#db.prepare("SELECT data FROM ferments WHERE worktree_path = ?").all(worktreePath) as Array<{
			data: string;
		}>;
		const ferments: Ferment[] = [];
		for (const row of rows) {
			try {
				ferments.push(JSON.parse(row.data) as Ferment);
			} catch (err) {
				logger.warn("FermentStore failed to parse ferment in listByWorktree", { error: String(err) });
			}
		}
		return ferments;
	}

	/** Delete a ferment and its events. Clears from cache. */
	delete(id: string): void {
		const tx = this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM ferments WHERE id = ?").run(id);
			this.#db.prepare("DELETE FROM ferment_events WHERE ferment_id = ?").run(id);
		});
		tx();
		this.#cache.delete(id);
	}

	/** Get all events for a ferment (for audit/replay). */
	getEvents(fermentId: string): FermentEvent[] {
		const rows = this.#db
			.prepare(
				"SELECT id, event_type, event_data, created_at FROM ferment_events WHERE ferment_id = ? ORDER BY id ASC",
			)
			.all(fermentId) as Array<{
			id: number;
			event_type: string;
			event_data: string | null;
			created_at: number;
		}>;
		return rows.map(row => ({
			id: row.id,
			fermentId,
			eventType: row.event_type,
			eventData: row.event_data ? JSON.parse(row.event_data) : undefined,
			createdAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : undefined,
		}));
	}

	/** Check if a ferment is cached (active). */
	isActive(fermentId: string): boolean {
		return this.#cache.has(fermentId);
	}

	/** Append events without re-saving the ferment blob. */
	appendEvents(events: FermentEvent[]): void {
		if (events.length === 0) return;
		const now = Math.floor(Date.now() / 1000);
		const tx = this.#db.transaction(() => {
			const insertEvent = this.#db.prepare(
				`INSERT INTO ferment_events (ferment_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?)`,
			);
			for (const evt of events) {
				insertEvent.run(
					evt.fermentId,
					evt.eventType,
					evt.eventData ? JSON.stringify(evt.eventData) : null,
					evt.createdAt ? Math.floor(new Date(evt.createdAt).getTime() / 1000) : now,
				);
			}
		});
		tx();
	}
}
