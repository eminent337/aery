import { Database, type Statement } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	InsertObservationParams,
	ObservationCategory,
	ObservationRecord,
	SearchObservationsOptions,
} from "./types";

interface ObservationRow {
	id: string;
	session_id: string;
	entry_id: string | null;
	turn_index: number;
	category: string;
	title: string;
	summary: string;
	files_json: string;
	context_json: string;
	created_at: number;
}

export interface ProgressiveMemoryStoreOptions {
	dbPath?: string;
}

function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(tok => tok.length > 0);
}

function mapRowToRecord(row: ObservationRow): ObservationRecord {
	let files: string[] = [];
	try {
		const parsed = JSON.parse(row.files_json);
		if (Array.isArray(parsed)) {
			files = parsed.map(item => String(item));
		}
	} catch {
		files = [];
	}

	let context: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(row.context_json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
			context = parsed as Record<string, unknown>;
		}
	} catch {
		context = undefined;
	}

	return {
		id: row.id,
		sessionId: row.session_id,
		entryId: row.entry_id,
		turnIndex: row.turn_index,
		category: row.category as ObservationCategory,
		title: row.title,
		summary: row.summary,
		files,
		context,
		createdAt: row.created_at,
	};
}

/**
 * In-process progressive memory store backed by SQLite with FTS5 lexical indexing.
 *
 * See file:///home/aryee/aery/ai_agent/docs/superpowers/specs/2026-11-08-progressive-memory-engine-design.md
 */
export class ProgressiveMemoryStore {
	readonly #db: Database;
	#closed = false;
	#insertStmt!: Statement<
		void,
		[string, string, string | null, number, string, string, string, string, string, number]
	>;
	#getStmt!: Statement<ObservationRow, [string]>;
	#listRecentStmt!: Statement<ObservationRow, [number]>;
	#deleteStmt!: Statement<void, [string]>;
	#countStmt!: Statement<{ count: number }, []>;
	#searchStmt!: Statement<ObservationRow, [string, number]>;
	#searchWithCategoryStmt!: Statement<ObservationRow, [string, string, number]>;

	constructor(dbPathOrOptions?: string | ProgressiveMemoryStoreOptions) {
		let resolvedPath: string;
		if (typeof dbPathOrOptions === "string") {
			resolvedPath = dbPathOrOptions;
		} else if (dbPathOrOptions?.dbPath) {
			resolvedPath = dbPathOrOptions.dbPath;
		} else {
			resolvedPath = path.join(process.cwd(), ".aery", "memory", "project-memory.db");
		}

		if (resolvedPath !== ":memory:") {
			fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
		}

		this.#db = new Database(resolvedPath);
		this.#initializeSchema();
		this.#prepareStatements();
	}

	/**
	 * Access the underlying bun:sqlite Database instance.
	 */
	get rawDb(): Database {
		return this.#db;
	}

	#initializeSchema(): void {
		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    entry_id TEXT,
    turn_index INTEGER NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('decision', 'bugfix', 'discovery', 'feature')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    files_json TEXT NOT NULL DEFAULT '[]',
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_category ON observations(category);
CREATE INDEX IF NOT EXISTS idx_observations_created_at ON observations(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    id UNINDEXED,
    title,
    summary,
    content='observations',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, id, title, summary)
    VALUES (new.rowid, new.id, new.title, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, id, title, summary)
    VALUES ('delete', old.rowid, old.id, old.title, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, id, title, summary)
    VALUES ('delete', old.rowid, old.id, old.title, old.summary);
    INSERT INTO observations_fts(rowid, id, title, summary)
    VALUES (new.rowid, new.id, new.title, new.summary);
END;
		`);
	}

	#prepareStatements(): void {
		this.#insertStmt = this.#db.prepare(`
			INSERT INTO observations (
				id, session_id, entry_id, turn_index, category, title, summary, files_json, context_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#getStmt = this.#db.prepare(`
			SELECT id, session_id, entry_id, turn_index, category, title, summary, files_json, context_json, created_at
			FROM observations
			WHERE id = ?
		`);

		this.#listRecentStmt = this.#db.prepare(`
			SELECT id, session_id, entry_id, turn_index, category, title, summary, files_json, context_json, created_at
			FROM observations
			ORDER BY created_at DESC, rowid DESC
			LIMIT ?
		`);

		this.#deleteStmt = this.#db.prepare(`
			DELETE FROM observations WHERE id = ?
		`);

		this.#countStmt = this.#db.prepare(`
			SELECT COUNT(*) AS count FROM observations
		`);

		this.#searchStmt = this.#db.prepare(`
			SELECT o.id, o.session_id, o.entry_id, o.turn_index, o.category, o.title, o.summary, o.files_json, o.context_json, o.created_at
			FROM observations_fts f
			JOIN observations o ON f.rowid = o.rowid
			WHERE observations_fts MATCH ?
			ORDER BY o.created_at DESC
			LIMIT ?
		`);

		this.#searchWithCategoryStmt = this.#db.prepare(`
			SELECT o.id, o.session_id, o.entry_id, o.turn_index, o.category, o.title, o.summary, o.files_json, o.context_json, o.created_at
			FROM observations_fts f
			JOIN observations o ON f.rowid = o.rowid
			WHERE observations_fts MATCH ? AND o.category = ?
			ORDER BY o.created_at DESC
			LIMIT ?
		`);
	}

	insertObservation(params: InsertObservationParams): ObservationRecord {
		const id = params.id ?? `obs-${crypto.randomUUID().slice(0, 8)}`;
		const createdAt = params.createdAt ?? Date.now();
		const files = params.files ?? [];
		const context = params.context;
		const entryId = params.entryId ?? null;

		const filesJson = JSON.stringify(files);
		const contextJson = JSON.stringify(context ?? {});

		this.#insertStmt.run(
			id,
			params.sessionId,
			entryId,
			params.turnIndex,
			params.category,
			params.title,
			params.summary,
			filesJson,
			contextJson,
			createdAt,
		);

		return {
			id,
			sessionId: params.sessionId,
			entryId,
			turnIndex: params.turnIndex,
			category: params.category,
			title: params.title,
			summary: params.summary,
			files,
			context: context && Object.keys(context).length > 0 ? context : undefined,
			createdAt,
		};
	}

	getObservation(id: string): ObservationRecord | null {
		const row = this.#getStmt.get(id);
		if (!row) {
			return null;
		}
		return mapRowToRecord(row);
	}

	listRecentObservations(limit = 10): ObservationRecord[] {
		const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
		const rows = this.#listRecentStmt.all(safeLimit);
		return rows.map(mapRowToRecord);
	}

	searchObservations(options: SearchObservationsOptions): ObservationRecord[] {
		if (options.limit !== undefined && options.limit <= 0) {
			return [];
		}

		const tokens = tokenizeQuery(options.query);
		if (tokens.length === 0) {
			return [];
		}

		const safeLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 1000));
		const ftsMatch = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");

		try {
			if (options.category) {
				const rows = this.#searchWithCategoryStmt.all(ftsMatch, options.category, safeLimit);
				return rows.map(mapRowToRecord);
			}

			const rows = this.#searchStmt.all(ftsMatch, safeLimit);
			return rows.map(mapRowToRecord);
		} catch {
			return [];
		}
	}

	get isClosed(): boolean {
		return this.#closed;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new Error("ProgressiveMemoryStore is closed");
		}
	}

	deleteObservation(id: string): boolean {
		this.#assertOpen();
		const result = this.#deleteStmt.run(id) as { changes?: number } | undefined;
		return (result?.changes ?? 0) > 0;
	}

	getObservationCount(): number {
		this.#assertOpen();
		const row = this.#countStmt.get();
		return row?.count ?? 0;
	}

	countObservations(): number {
		return this.getObservationCount();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}
}
