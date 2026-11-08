import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProgressiveMemoryStore } from "../../src/memory/progressive-memory-store";

describe("ProgressiveMemoryStore", () => {
	let tempDir: string;
	let dbPath: string;
	let store: ProgressiveMemoryStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "progressive-memory-test-"));
		dbPath = path.join(tempDir, "test-memory.db");
		store = new ProgressiveMemoryStore(dbPath);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	describe("initialization and table creation", () => {
		it("initializes tables, indexes, and triggers properly", () => {
			const rawDb = store.rawDb;
			const tables = rawDb
				.prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map(row => row.name);

			expect(tables).toContain("observations");
			expect(tables).toContain("observations_fts");

			const triggers = rawDb
				.prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
				.all()
				.map(row => row.name);

			expect(triggers).toContain("observations_ai");
			expect(triggers).toContain("observations_ad");
			expect(triggers).toContain("observations_au");
		});

		it("creates default database directory if it does not exist", async () => {
			const nestedDir = path.join(tempDir, "nested", "dir");
			const nestedDbPath = path.join(nestedDir, "project-memory.db");
			const nestedStore = new ProgressiveMemoryStore(nestedDbPath);
			expect(nestedStore.getObservationCount()).toBe(0);
			nestedStore.close();

			const stats = await fs.stat(nestedDbPath);
			expect(stats.isFile()).toBe(true);
		});
	});

	describe("insert and retrieve observations", () => {
		it("inserts an observation and retrieves it by ID", () => {
			const created = store.insertObservation({
				id: "obs-test-1",
				sessionId: "sess-100",
				entryId: "entry-50",
				turnIndex: 2,
				category: "decision",
				title: "Use SQLite FTS5 for in-process memory",
				summary: "Adopted SQLite FTS5 to eliminate external daemon dependencies.",
				files: ["packages/coding-agent/src/memory/progressive-memory-store.ts"],
				context: { reason: "latency", benchmarkMs: 1.5 },
				createdAt: 1700000000000,
			});

			expect(created.id).toBe("obs-test-1");
			expect(created.sessionId).toBe("sess-100");
			expect(created.entryId).toBe("entry-50");
			expect(created.turnIndex).toBe(2);
			expect(created.category).toBe("decision");
			expect(created.title).toBe("Use SQLite FTS5 for in-process memory");
			expect(created.files).toEqual(["packages/coding-agent/src/memory/progressive-memory-store.ts"]);
			expect(created.context).toEqual({ reason: "latency", benchmarkMs: 1.5 });
			expect(created.createdAt).toBe(1700000000000);

			const fetched = store.getObservation("obs-test-1");
			expect(fetched).not.toBeNull();
			expect(fetched).toEqual(created);
		});

		it("inserts with defaults when optional fields are omitted", () => {
			const beforeInsert = Date.now();
			const created = store.insertObservation({
				sessionId: "sess-200",
				turnIndex: 0,
				category: "bugfix",
				title: "Fix null pointer in search",
				summary: "Handled empty query tokens safely.",
			});

			expect(created.id).toBeDefined();
			expect(typeof created.id).toBe("string");
			expect(created.id.length).toBeGreaterThan(0);
			expect(created.entryId).toBeNull();
			expect(created.files).toEqual([]);
			expect(created.context).toBeUndefined();
			expect(created.createdAt).toBeGreaterThanOrEqual(beforeInsert);

			const fetched = store.getObservation(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched?.title).toBe("Fix null pointer in search");
			expect(fetched?.files).toEqual([]);
		});

		it("returns null when observation is not found", () => {
			const fetched = store.getObservation("non-existent-id");
			expect(fetched).toBeNull();
		});
	});

	describe("listRecentObservations and getObservationCount", () => {
		it("lists recent observations ordered by createdAt descending with limit", () => {
			for (let i = 1; i <= 5; i++) {
				store.insertObservation({
					id: `obs-${i}`,
					sessionId: "sess-1",
					turnIndex: i,
					category: "feature",
					title: `Feature milestone ${i}`,
					summary: `Implemented feature number ${i}`,
					createdAt: 1000 + i * 100,
				});
			}

			expect(store.getObservationCount()).toBe(5);

			const recentThree = store.listRecentObservations(3);
			expect(recentThree).toHaveLength(3);
			expect(recentThree[0].id).toBe("obs-5");
			expect(recentThree[1].id).toBe("obs-4");
			expect(recentThree[2].id).toBe("obs-3");

			const allRecent = store.listRecentObservations(10);
			expect(allRecent).toHaveLength(5);
			expect(allRecent[4].id).toBe("obs-1");
		});
	});

	describe("deleteObservation", () => {
		it("deletes an existing observation and updates count", () => {
			store.insertObservation({
				id: "obs-to-delete",
				sessionId: "sess-1",
				turnIndex: 1,
				category: "discovery",
				title: "Discovered temporary file leak",
				summary: "Files were not cleaned up after tests.",
			});

			expect(store.getObservationCount()).toBe(1);
			const deleted = store.deleteObservation("obs-to-delete");
			expect(deleted).toBe(true);
			expect(store.getObservationCount()).toBe(0);
			expect(store.getObservation("obs-to-delete")).toBeNull();

			const deletedAgain = store.deleteObservation("obs-to-delete");
			expect(deletedAgain).toBe(false);
		});
	});

	describe("FTS5 lexical search", () => {
		beforeEach(() => {
			store.insertObservation({
				id: "obs-1",
				sessionId: "sess-1",
				turnIndex: 1,
				category: "feature",
				title: "Add git checkpointing",
				summary: "Implemented hidden-ref workspace checkpoint service for undo/redo.",
				createdAt: 1000,
			});

			store.insertObservation({
				id: "obs-2",
				sessionId: "sess-1",
				turnIndex: 2,
				category: "decision",
				title: "Use isolated GIT_INDEX_FILE",
				summary: "Avoid workspace staging area conflicts by pointing to custom index file.",
				createdAt: 2000,
			});

			store.insertObservation({
				id: "obs-3",
				sessionId: "sess-1",
				turnIndex: 3,
				category: "bugfix",
				title: "Fix sandbox EROFS test errors",
				summary: "Configured HOME=/tmp to prevent read-only filesystem errors during bun test.",
				createdAt: 3000,
			});

			store.insertObservation({
				id: "obs-4",
				sessionId: "sess-1",
				turnIndex: 4,
				category: "discovery",
				title: "Discovered FTS5 external content trigger behavior",
				summary: "Triggers on external content tables must reference content rowid explicitly.",
				createdAt: 4000,
			});
		});

		it("searches matching keywords in title", () => {
			const results = store.searchObservations({ query: "checkpointing" });
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("obs-1");
		});

		it("searches matching keywords in summary", () => {
			const results = store.searchObservations({ query: "staging conflicts" });
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("obs-2");
		});

		it("searches with category filter", () => {
			const decisionOnly = store.searchObservations({
				query: "isolated",
				category: "decision",
			});
			expect(decisionOnly).toHaveLength(1);
			expect(decisionOnly[0].id).toBe("obs-2");

			const bugfixMismatch = store.searchObservations({
				query: "isolated",
				category: "bugfix",
			});
			expect(bugfixMismatch).toHaveLength(0);
		});

		it("returns empty array for empty or whitespace query", () => {
			expect(store.searchObservations({ query: "" })).toEqual([]);
			expect(store.searchObservations({ query: "    " })).toEqual([]);
		});

		it("respects limit option", () => {
			const results = store.searchObservations({ query: "content errors checkpointing file", limit: 2 });
			expect(results.length).toBeLessThanOrEqual(2);
		});
	});

	describe("FTS5 trigger synchronization", () => {
		it("synchronizes insert, update, and delete with FTS index", () => {
			const rawDb = store.rawDb;

			store.insertObservation({
				id: "obs-sync-1",
				sessionId: "sess-sync",
				turnIndex: 1,
				category: "discovery",
				title: "Original Title Alpha",
				summary: "Original summary mentioning quantum telemetry.",
				createdAt: 1000,
			});

			// Verify FTS row created
			const initialFtsRows = rawDb
				.prepare<{ id: string; title: string }, [string]>("SELECT id, title FROM observations_fts WHERE id = ?")
				.all("obs-sync-1");
			expect(initialFtsRows).toHaveLength(1);
			expect(initialFtsRows[0].title).toBe("Original Title Alpha");

			// Search finds initial record
			const initialSearch = store.searchObservations({ query: "telemetry" });
			expect(initialSearch).toHaveLength(1);
			expect(initialSearch[0].id).toBe("obs-sync-1");

			// Update in observations table
			rawDb.run(
				"UPDATE observations SET title = 'Updated Title Beta', summary = 'Updated summary with relativistic sensors.' WHERE id = 'obs-sync-1'",
			);

			// Old search should no longer find it
			const oldSearch = store.searchObservations({ query: "telemetry" });
			expect(oldSearch).toHaveLength(0);

			// New search finds it
			const newSearch = store.searchObservations({ query: "relativistic" });
			expect(newSearch).toHaveLength(1);
			expect(newSearch[0].id).toBe("obs-sync-1");
			expect(newSearch[0].title).toBe("Updated Title Beta");

			// Delete from observations table
			store.deleteObservation("obs-sync-1");

			// FTS row should be deleted
			const postDeleteFts = rawDb
				.prepare<{ id: string }, [string]>("SELECT id FROM observations_fts WHERE id = ?")
				.all("obs-sync-1");
			expect(postDeleteFts).toHaveLength(0);

			// Search should yield no results
			const postDeleteSearch = store.searchObservations({ query: "relativistic" });
			expect(postDeleteSearch).toHaveLength(0);
		});
	});
});
