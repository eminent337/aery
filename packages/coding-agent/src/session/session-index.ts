import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir as getDefaultAgentDir,
	logger,
	parseJsonlLenient,
	pathIsWithin,
	resolveEquivalentPath,
} from "@aryee337/aery-utils";
import { resolveRepositorySync } from "../utils/git";

export interface SessionIndexRecord {
	sessionId: string;
	filePath: string;
	cwd: string;
	canonicalCwd: string;
	workspaceRoot: string;
	title?: string;
	messageCount: number;
	createdAt: number;
	updatedAt: number;
	firstPrompt?: string;
	parentSession?: string;
}

interface RawSessionIndexRow {
	session_id: string;
	file_path: string;
	cwd: string;
	canonical_cwd: string;
	workspace_root: string;
	title: string | null;
	message_count: number;
	created_at: number;
	updated_at: number;
	first_prompt: string | null;
	parent_session: string | null;
}

const WORKSPACE_INDICATORS = [
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	".git",
];

/**
 * Resolve the root workspace directory for a given directory path.
 * If inside a Git repository, returns the top-level repository root.
 * Otherwise, scans ancestor directories for common project root markers.
 */
export function getWorkspaceRoot(dir: string): string {
	const canonical = resolveEquivalentPath(dir);
	try {
		const gitRepo = resolveRepositorySync(canonical);
		if (gitRepo?.repoRoot) {
			return resolveEquivalentPath(gitRepo.repoRoot);
		}
	} catch {}

	let current = canonical;
	const home = resolveEquivalentPath(process.env.HOME || "");

	while (current && current !== path.dirname(current)) {
		if (home && current === home) break;
		for (const indicator of WORKSPACE_INDICATORS) {
			try {
				if (fs.existsSync(path.join(current, indicator))) {
					return current;
				}
			} catch {}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return canonical;
}

/**
 * Checks whether two directory paths belong to the same workspace or project.
 */
export function isSameWorkspace(dirA: string, dirB: string): boolean {
	const canonicalA = resolveEquivalentPath(dirA);
	const canonicalB = resolveEquivalentPath(dirB);
	if (canonicalA === canonicalB) return true;

	const rootA = getWorkspaceRoot(canonicalA);
	const rootB = getWorkspaceRoot(canonicalB);
	if (rootA === rootB) return true;

	if (pathIsWithin(canonicalA, canonicalB) || pathIsWithin(canonicalB, canonicalA)) {
		return true;
	}

	return false;
}

const instances = new Map<string, SessionIndexStore>();
let defaultDbSynced = false;

export class SessionIndexStore {
	readonly #db: Database;
	readonly #dbPath: string;

	readonly #upsertStmt: Statement;
	readonly #getRecentWithMessagesStmt: Statement;
	readonly #getRecentAnyStmt: Statement;
	readonly #listForWorkspaceStmt: Statement;
	readonly #listAllStmt: Statement;
	readonly #deleteStmt: Statement;
	readonly #hasFileStmt: Statement;

	private constructor(db: Database, dbPath: string) {
		this.#db = db;
		this.#dbPath = dbPath;

		this.#db.run(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS session_index (
				session_id TEXT PRIMARY KEY,
				file_path TEXT NOT NULL,
				cwd TEXT NOT NULL,
				canonical_cwd TEXT NOT NULL,
				workspace_root TEXT NOT NULL,
				title TEXT,
				message_count INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				first_prompt TEXT,
				parent_session TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_session_index_workspace ON session_index(workspace_root, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_session_index_canonical_cwd ON session_index(canonical_cwd, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_session_index_updated_at ON session_index(updated_at DESC);
		`);

		this.#upsertStmt = this.#db.prepare(`
			INSERT INTO session_index (
				session_id, file_path, cwd, canonical_cwd, workspace_root,
				title, message_count, created_at, updated_at, first_prompt, parent_session
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				file_path = excluded.file_path,
				cwd = excluded.cwd,
				canonical_cwd = excluded.canonical_cwd,
				workspace_root = excluded.workspace_root,
				title = coalesce(excluded.title, session_index.title),
				message_count = max(excluded.message_count, session_index.message_count),
				updated_at = max(excluded.updated_at, session_index.updated_at),
				first_prompt = coalesce(excluded.first_prompt, session_index.first_prompt),
				parent_session = coalesce(excluded.parent_session, session_index.parent_session)
		`);

		this.#getRecentWithMessagesStmt = this.#db.prepare(`
			SELECT * FROM session_index
			WHERE (canonical_cwd = ? OR workspace_root = ?) AND message_count > 0
			ORDER BY updated_at DESC
			LIMIT 1
		`);

		this.#getRecentAnyStmt = this.#db.prepare(`
			SELECT * FROM session_index
			WHERE canonical_cwd = ? OR workspace_root = ?
			ORDER BY updated_at DESC
			LIMIT 1
		`);

		this.#listForWorkspaceStmt = this.#db.prepare(`
			SELECT * FROM session_index
			WHERE canonical_cwd = ? OR workspace_root = ?
			ORDER BY updated_at DESC
		`);

		this.#listAllStmt = this.#db.prepare(`
			SELECT * FROM session_index
			ORDER BY updated_at DESC
		`);

		this.#deleteStmt = this.#db.prepare(`
			DELETE FROM session_index WHERE session_id = ? OR file_path = ?
		`);

		this.#hasFileStmt = this.#db.prepare(`
			SELECT 1 FROM session_index WHERE file_path = ? LIMIT 1
		`);
	}

	static open(dbPath?: string): SessionIndexStore {
		const resolvedPath = dbPath ?? path.join(getDefaultAgentDir(), "session_index.db");
		let instance = instances.get(resolvedPath);
		if (!instance) {
			const dir = path.dirname(resolvedPath);
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch (err) {
				const code = (err as { code?: string })?.code;
				if (code !== "EEXIST") {
					throw new Error(`Failed to create SessionIndexStore directory: ${code || String(err)}`);
				}
			}
			const db = new Database(resolvedPath, { create: true });
			instance = new SessionIndexStore(db, resolvedPath);
			instances.set(resolvedPath, instance);
		}
		if (!dbPath && !defaultDbSynced) {
			defaultDbSynced = true;
			setTimeout(() => {
				instance?.syncFromDisk(path.join(getDefaultAgentDir(), "sessions")).catch(() => {});
			}, 50);
		}
		return instance;
	}

	static closeAll(): void {
		for (const [key, instance] of instances) {
			try {
				instance.close();
			} catch {}
			instances.delete(key);
		}
	}

	close(): void {
		try {
			this.#db.close();
		} catch {}
		instances.delete(this.#dbPath);
	}

	upsertSession(record: SessionIndexRecord): void {
		try {
			this.#upsertStmt.run(
				record.sessionId,
				record.filePath,
				record.cwd,
				record.canonicalCwd,
				record.workspaceRoot,
				record.title ?? null,
				record.messageCount,
				record.createdAt,
				record.updatedAt,
				record.firstPrompt ?? null,
				record.parentSession ?? null,
			);
		} catch (err) {
			logger.warn("SessionIndexStore failed to upsert session", { sessionId: record.sessionId, error: String(err) });
		}
	}

	getMostRecentForWorkspace(cwd: string): SessionIndexRecord | null {
		const canonical = resolveEquivalentPath(cwd);
		const wsRoot = getWorkspaceRoot(canonical);
		try {
			let row = this.#getRecentWithMessagesStmt.get(canonical, wsRoot) as RawSessionIndexRow | undefined;
			if (!row) {
				row = this.#getRecentAnyStmt.get(canonical, wsRoot) as RawSessionIndexRow | undefined;
			}
			return row ? this.#rowToRecord(row) : null;
		} catch (err) {
			logger.warn("SessionIndexStore failed to get most recent session", { cwd, error: String(err) });
			return null;
		}
	}

	listForWorkspace(cwd: string): SessionIndexRecord[] {
		const canonical = resolveEquivalentPath(cwd);
		const wsRoot = getWorkspaceRoot(canonical);
		try {
			const rows = this.#listForWorkspaceStmt.all(canonical, wsRoot) as RawSessionIndexRow[];
			return rows.map(r => this.#rowToRecord(r));
		} catch (err) {
			logger.warn("SessionIndexStore failed to list workspace sessions", { cwd, error: String(err) });
			return [];
		}
	}

	listAll(): SessionIndexRecord[] {
		try {
			const rows = this.#listAllStmt.all() as RawSessionIndexRow[];
			return rows.map(r => this.#rowToRecord(r));
		} catch (err) {
			logger.warn("SessionIndexStore failed to list all sessions", { error: String(err) });
			return [];
		}
	}

	deleteSession(sessionIdOrPath: string): void {
		try {
			this.#deleteStmt.run(sessionIdOrPath, sessionIdOrPath);
		} catch (err) {
			logger.warn("SessionIndexStore failed to delete session", { sessionIdOrPath, error: String(err) });
		}
	}

	hasFile(filePath: string): boolean {
		try {
			return Boolean(this.#hasFileStmt.get(filePath));
		} catch {
			return false;
		}
	}

	#rowToRecord(row: RawSessionIndexRow): SessionIndexRecord {
		return {
			sessionId: row.session_id,
			filePath: row.file_path,
			cwd: row.cwd,
			canonicalCwd: row.canonical_cwd,
			workspaceRoot: row.workspace_root,
			title: row.title ?? undefined,
			messageCount: row.message_count,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			firstPrompt: row.first_prompt ?? undefined,
			parentSession: row.parent_session ?? undefined,
		};
	}

	/**
	 * Scans the sessions directory on disk and populates any missing sessions into the index.
	 */
	async syncFromDisk(sessionsRoot: string): Promise<void> {
		try {
			if (!fs.existsSync(sessionsRoot)) return;
			const files = await Array.fromAsync(new Bun.Glob("*/*.jsonl").scan(sessionsRoot), name =>
				path.join(sessionsRoot, name),
			);
			for (const file of files) {
				if (this.hasFile(file)) continue;
				try {
					const stat = fs.statSync(file);
					if (stat.size === 0) continue;
					const handle = await Bun.file(file).slice(0, 4096).text();
					const entries = parseJsonlLenient<Record<string, unknown>>(handle);
					if (entries.length === 0) continue;
					const header = entries[0];
					if (header?.type !== "session" || typeof header.id !== "string") continue;

					const cwd = typeof header.cwd === "string" ? header.cwd : "";
					const canonicalCwd = cwd ? resolveEquivalentPath(cwd) : "";
					const workspaceRoot = canonicalCwd ? getWorkspaceRoot(canonicalCwd) : "";

					let messageCount = 0;
					let firstPrompt: string | undefined;
					for (let i = 1; i < entries.length; i++) {
						const e = entries[i];
						if (e?.type === "message") {
							messageCount++;
							if (!firstPrompt && typeof e.message === "object" && e.message !== null) {
								const msg = e.message as { role?: string; content?: unknown };
								if (msg.role === "user") {
									firstPrompt = typeof msg.content === "string" ? msg.content : undefined;
								}
							}
						}
					}

					this.upsertSession({
						sessionId: header.id,
						filePath: file,
						cwd,
						canonicalCwd,
						workspaceRoot,
						title: typeof header.title === "string" ? header.title : undefined,
						messageCount,
						createdAt: header.timestamp ? new Date(header.timestamp as string).getTime() : stat.birthtimeMs,
						updatedAt: stat.mtimeMs,
						firstPrompt,
						parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
					});
				} catch {}
			}
		} catch (err) {
			logger.warn("SessionIndexStore failed to sync from disk", { error: String(err) });
		}
	}
}
