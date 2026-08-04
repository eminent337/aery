import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@aryee337/aery-utils";
import type { SwarmWorkflow, TaskState } from "./types.js";

/** Persistent representation of a Swarm in progress */
export interface PersistedSwarm {
	id: string;
	workflow: SwarmWorkflow;
	taskStates: Record<string, TaskState>;
	status: "active" | "completed" | "failed";
	createdAt: number;
	updatedAt: number;
}

const instances = new Map<string, SwarmStore>();

export class SwarmStore {
	#db: Database;

	private constructor(db: Database) {
		this.#db = db;
	}

	#initializeSchema(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS swarms (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER,
				updated_at INTEGER
			);
		`);
	}

	static open(dbPath?: string): SwarmStore {
		const resolved = dbPath ?? getAgentDbPath();
		const storePath = path.join(path.dirname(resolved), "swarm_state.db");
		
		const existing = instances.get(storePath);
		if (existing) return existing;

		const dir = path.dirname(storePath);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw new Error(`Failed to create SwarmStore directory: ${code || String(err)}`);
			}
		}

		const db = new Database(storePath);
		const store = new SwarmStore(db);
		store.#initializeSchema();
		instances.set(storePath, store);
		return store;
	}

	save(swarm: PersistedSwarm): void {
		const now = Math.floor(Date.now() / 1000);
		swarm.updatedAt = now;
		if (!swarm.createdAt) swarm.createdAt = now;

		this.#db.prepare(
			`INSERT INTO swarms (id, data, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   data = excluded.data,
			   status = excluded.status,
			   updated_at = excluded.updated_at`
		).run(swarm.id, JSON.stringify(swarm), swarm.status, swarm.createdAt, swarm.updatedAt);
	}

	get(id: string): PersistedSwarm | null {
		const row = this.#db.prepare("SELECT data FROM swarms WHERE id = ?").get(id) as { data: string } | undefined;
		if (!row) return null;

		try {
			return JSON.parse(row.data) as PersistedSwarm;
		} catch (err) {
			logger.warn("SwarmStore failed to parse swarm data", { id, error: String(err) });
			return null;
		}
	}

	listActive(): PersistedSwarm[] {
		const rows = this.#db.prepare("SELECT data FROM swarms WHERE status = 'active'").all() as Array<{ data: string }>;
		const swarms: PersistedSwarm[] = [];
		for (const row of rows) {
			try {
				swarms.push(JSON.parse(row.data) as PersistedSwarm);
			} catch (err) {
				logger.warn("SwarmStore failed to parse swarm in listActive", { error: String(err) });
			}
		}
		return swarms;
	}

	delete(id: string): void {
		this.#db.prepare("DELETE FROM swarms WHERE id = ?").run(id);
	}
}
