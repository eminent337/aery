import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@aryee337/aery-utils";
import type { Lock, QueueEntry, StateAdapter } from "chat";

/**
 * Persistent SQLite-backed StateAdapter for Slack & Telegram connectors.
 * Implements the full StateAdapter interface required by the Chat SDK:
 * - KV storage (get, set, setIfNotExists, delete)
 * - Lists & appendToList with TTL / maxLength
 * - Distributed Locking (acquireLock, releaseLock, extendLock, forceReleaseLock)
 * - Message queue (enqueue, dequeue, queueDepth)
 * - Thread subscriptions (subscribe, unsubscribe, isSubscribed)
 * - Lifecycle (connect, disconnect)
 */
export class SqliteStateAdapter implements StateAdapter {
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
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS kv_store (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS list_store (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_list_key ON list_store(key);

			CREATE TABLE IF NOT EXISTS locks (
				thread_id TEXT PRIMARY KEY,
				token TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS queue_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				thread_id TEXT NOT NULL,
				data TEXT NOT NULL,
				enqueued_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_queue_thread ON queue_entries(thread_id);

			CREATE TABLE IF NOT EXISTS subscriptions (
				thread_id TEXT PRIMARY KEY,
				subscribed_at INTEGER NOT NULL
			);
		`);
	}

	async connect(): Promise<void> {
		// Connection established synchronously in constructor with bun:sqlite
	}

	async disconnect(): Promise<void> {
		// No-op for bun:sqlite persistent connection
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const now = Date.now();
		const row = this.#db
			.prepare("SELECT value, expires_at FROM kv_store WHERE key = ?")
			.get(key) as { value: string; expires_at: number | null } | undefined;

		if (!row) return null;
		if (row.expires_at !== null && row.expires_at <= now) {
			this.#db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
			return null;
		}

		try {
			return JSON.parse(row.value) as T;
		} catch (err) {
			logger.warn("SqliteStateAdapter: Failed to parse KV JSON", { key, error: String(err) });
			return null;
		}
	}

	async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
		const expiresAt = ttlMs ? Date.now() + ttlMs : null;
		this.#db
			.prepare(
				`INSERT INTO kv_store (key, value, expires_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
				   value = excluded.value,
				   expires_at = excluded.expires_at`,
			)
			.run(key, JSON.stringify(value), expiresAt);
	}

	async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
		const now = Date.now();
		const existing = await this.get(key);
		if (existing !== null) {
			return false;
		}

		const expiresAt = ttlMs ? now + ttlMs : null;
		try {
			const res = this.#db
				.prepare("INSERT OR IGNORE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)")
				.run(key, JSON.stringify(value), expiresAt);
			return res.changes > 0;
		} catch {
			return false;
		}
	}

	async delete(key: string): Promise<void> {
		this.#db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
		this.#db.prepare("DELETE FROM list_store WHERE key = ?").run(key);
	}

	async getList<T = unknown>(key: string): Promise<T[]> {
		const now = Date.now();
		// Clean up expired items
		this.#db.prepare("DELETE FROM list_store WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?").run(key, now);

		const rows = this.#db
			.prepare("SELECT value FROM list_store WHERE key = ? ORDER BY id ASC")
			.all(key) as Array<{ value: string }>;

		const results: T[] = [];
		for (const row of rows) {
			try {
				results.push(JSON.parse(row.value));
			} catch (err) {
				logger.warn("SqliteStateAdapter: Failed to parse list item JSON", { key, error: String(err) });
			}
		}
		return results;
	}

	async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
		const now = Date.now();
		const expiresAt = options?.ttlMs ? now + options.ttlMs : null;

		this.#db
			.prepare("INSERT INTO list_store (key, value, created_at, expires_at) VALUES (?, ?, ?, ?)")
			.run(key, JSON.stringify(value), now, expiresAt);

		// If TTL specified, update existing items' expires_at in this list as well
		if (expiresAt !== null) {
			this.#db.prepare("UPDATE list_store SET expires_at = ? WHERE key = ?").run(expiresAt, key);
		}

		// Enforce maxLength (keep newest items)
		if (options?.maxLength && options.maxLength > 0) {
			this.#db
				.prepare(
					`DELETE FROM list_store WHERE key = ? AND id NOT IN (
						SELECT id FROM list_store WHERE key = ? ORDER BY id DESC LIMIT ?
					)`,
				)
				.run(key, key, options.maxLength);
		}
	}

	async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
		const now = Date.now();
		const expiresAt = now + ttlMs;
		const token = crypto.randomUUID();

		// Purge expired lock if any
		this.#db.prepare("DELETE FROM locks WHERE thread_id = ? AND expires_at <= ?").run(threadId, now);

		try {
			const res = this.#db
				.prepare("INSERT OR IGNORE INTO locks (thread_id, token, expires_at) VALUES (?, ?, ?)")
				.run(threadId, token, expiresAt);

			if (res.changes > 0) {
				return { threadId, token, expiresAt };
			}
			return null;
		} catch {
			return null;
		}
	}

	async releaseLock(lock: Lock): Promise<void> {
		this.#db.prepare("DELETE FROM locks WHERE thread_id = ? AND token = ?").run(lock.threadId, lock.token);
	}

	async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
		const now = Date.now();
		const newExpiresAt = now + ttlMs;

		const res = this.#db
			.prepare("UPDATE locks SET expires_at = ? WHERE thread_id = ? AND token = ? AND expires_at > ?")
			.run(newExpiresAt, lock.threadId, lock.token, now);

		if (res.changes > 0) {
			lock.expiresAt = newExpiresAt;
			return true;
		}
		return false;
	}

	async forceReleaseLock(threadId: string): Promise<void> {
		this.#db.prepare("DELETE FROM locks WHERE thread_id = ?").run(threadId);
	}

	async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
		const now = Date.now();
		// Purge expired entries for this thread
		this.#db.prepare("DELETE FROM queue_entries WHERE thread_id = ? AND expires_at <= ?").run(threadId, now);

		// Current depth
		const countRow = this.#db
			.prepare("SELECT COUNT(*) as count FROM queue_entries WHERE thread_id = ?")
			.get(threadId) as { count: number };

		if (countRow.count >= maxSize) {
			// Evict oldest
			this.#db
				.prepare(
					`DELETE FROM queue_entries WHERE id = (
						SELECT id FROM queue_entries WHERE thread_id = ? ORDER BY id ASC LIMIT 1
					)`,
				)
				.run(threadId);
		}

		this.#db
			.prepare("INSERT INTO queue_entries (thread_id, data, enqueued_at, expires_at) VALUES (?, ?, ?, ?)")
			.run(threadId, JSON.stringify(entry), entry.enqueuedAt, entry.expiresAt);

		const updated = this.#db
			.prepare("SELECT COUNT(*) as count FROM queue_entries WHERE thread_id = ?")
			.get(threadId) as { count: number };
		return updated.count;
	}

	async dequeue(threadId: string): Promise<QueueEntry | null> {
		const now = Date.now();
		while (true) {
			const row = this.#db
				.prepare(
					"SELECT id, data, expires_at FROM queue_entries WHERE thread_id = ? ORDER BY id ASC LIMIT 1",
				)
				.get(threadId) as { id: number; data: string; expires_at: number } | undefined;

			if (!row) return null;

			// Delete the dequeued row
			this.#db.prepare("DELETE FROM queue_entries WHERE id = ?").run(row.id);

			if (row.expires_at > now) {
				try {
					return JSON.parse(row.data) as QueueEntry;
				} catch (err) {
					logger.warn("SqliteStateAdapter: Failed to parse queue entry JSON", { threadId, error: String(err) });
				}
			}
		}
	}

	async queueDepth(threadId: string): Promise<number> {
		const now = Date.now();
		this.#db.prepare("DELETE FROM queue_entries WHERE thread_id = ? AND expires_at <= ?").run(threadId, now);
		const row = this.#db
			.prepare("SELECT COUNT(*) as count FROM queue_entries WHERE thread_id = ?")
			.get(threadId) as { count: number };
		return row.count;
	}

	async subscribe(threadId: string): Promise<void> {
		const now = Date.now();
		this.#db
			.prepare("INSERT OR REPLACE INTO subscriptions (thread_id, subscribed_at) VALUES (?, ?)")
			.run(threadId, now);
	}

	async unsubscribe(threadId: string): Promise<void> {
		this.#db.prepare("DELETE FROM subscriptions WHERE thread_id = ?").run(threadId);
	}

	async isSubscribed(threadId: string): Promise<boolean> {
		const row = this.#db.prepare("SELECT thread_id FROM subscriptions WHERE thread_id = ?").get(threadId);
		return !!row;
	}
}
