import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@aryee337/aery-utils";

/**
 * Persistent SQLite-backed StateAdapter for Slack & Telegram connectors.
 * Preserves thread conversation states across process restarts.
 */
export class SqliteStateAdapter {
	#db: Database;

	constructor(dbPath?: string) {
		const resolved = dbPath ?? getAgentDbPath();
		const storePath = path.join(path.dirname(resolved), "connector_states.db");
		const dir = path.dirname(storePath);

		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw new Error(`Failed to create connector state directory: ${code || String(err)}`);
			}
		}

		this.#db = new Database(storePath);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS connector_states (
				thread_id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
	}

	async get(threadId: string): Promise<unknown | null> {
		const row = this.#db.prepare("SELECT data FROM connector_states WHERE thread_id = ?").get(threadId) as
			| { data: string }
			| undefined;
		if (!row) return null;
		try {
			return JSON.parse(row.data);
		} catch (err) {
			logger.warn("SqliteStateAdapter: Failed to parse state JSON", { threadId, error: String(err) });
			return null;
		}
	}

	async set(threadId: string, state: unknown): Promise<void> {
		const now = Math.floor(Date.now() / 1000);
		this.#db
			.prepare(
				`INSERT INTO connector_states (thread_id, data, updated_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(thread_id) DO UPDATE SET
				   data = excluded.data,
				   updated_at = excluded.updated_at`,
			)
			.run(threadId, JSON.stringify(state), now);
	}

	async delete(threadId: string): Promise<void> {
		this.#db.prepare("DELETE FROM connector_states WHERE thread_id = ?").run(threadId);
	}
}
