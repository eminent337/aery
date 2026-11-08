import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { ProgressiveMemoryCoordinator } from "../../src/memory/progressive-memory-coordinator";
import { ProgressiveMemoryStore } from "../../src/memory/progressive-memory-store";
import { createTools, type ToolSession } from "../../src/tools";
import {
	createMemoryRecallTool,
	createMemorySearchTool,
	formatObservationMarkdown,
	formatRelativeAge,
	formatSearchObservationItem,
	formatSearchResultsMarkdown,
	MemoryRecallTool,
	MemorySearchTool,
} from "../../src/tools/memory-progressive";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

describe("Autonomous Agent Tools (memory_recall & memory_search)", () => {
	let tempDir: string;
	let dbPath: string;
	let store: ProgressiveMemoryStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-memory-tools-test-"));
		dbPath = path.join(tempDir, "test-memory.db");
		store = new ProgressiveMemoryStore({ dbPath });
	});

	afterEach(async () => {
		if (!store.isClosed) {
			store.close();
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function createMockSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"memory.progressive.enabled": true,
				"memory.progressive.dbPath": dbPath,
			}),
			...overrides,
		};
	}

	function seedObservations() {
		store.insertObservation({
			id: "obs-1",
			sessionId: "session-alpha",
			turnIndex: 0,
			category: "decision",
			title: "Adopted SQLite FTS5 for local memory",
			summary: "Selected SQLite with FTS5 lexical search to achieve zero external dependencies.",
			files: ["src/memory/store.ts", "src/memory/schema.ts"],
			context: { rationale: "offline-first architecture", speed: "sub-millisecond" },
			createdAt: Date.now() - 3600000 * 2, // 2h ago
		});

		store.insertObservation({
			id: "obs-2",
			sessionId: "session-alpha",
			turnIndex: 1,
			category: "bugfix",
			title: "Fixed sandbox EROFS test errors",
			summary: "Exported HOME=/tmp in bun test to avoid permission denied in sandbox.",
			files: ["package.json"],
			context: { errorCode: "EROFS" },
			createdAt: Date.now() - 60000 * 15, // 15m ago
		});

		store.insertObservation({
			id: "obs-3",
			sessionId: "session-beta",
			turnIndex: 0,
			category: "feature",
			title: "Added hidden-ref workspace checkpointing",
			summary: "Implemented git checkpoint coordinator for automatic turn rollbacks.",
			files: ["src/checkpoint/coordinator.ts"],
			createdAt: Date.now() - 10000, // just now
		});

		store.insertObservation({
			id: "obs-4",
			sessionId: "session-beta",
			turnIndex: 1,
			category: "discovery",
			title: "Discovered Mnemopi bank isolation layout",
			summary: "Identified how per-project and global banks are partitioned in vector storage.",
			files: [],
			createdAt: Date.now() - 86400000 * 3, // 3d ago
		});
	}

	describe("formatRelativeAge and helper formatters", () => {
		it("formats relative age accurately", () => {
			const now = 1000000000000;
			expect(formatRelativeAge(now - 10000, now)).toBe("just now");
			expect(formatRelativeAge(now - 60000 * 5, now)).toBe("5m ago");
			expect(formatRelativeAge(now - 3600000 * 4, now)).toBe("4h ago");
			expect(formatRelativeAge(now - 86400000 * 2, now)).toBe("2d ago");
		});

		it("formats observation markdown with all expected fields", () => {
			const obs = {
				id: "obs-100",
				sessionId: "sess-1",
				entryId: null,
				turnIndex: 0,
				category: "bugfix" as const,
				title: "Fixed memory leak",
				summary: "Cleaned up event listeners on session close.",
				files: ["src/event-bus.ts"],
				context: { leakType: "listeners" },
				createdAt: 1700000000000,
			};
			const md = formatObservationMarkdown(obs);
			expect(md).toContain("### Observation: obs-100");
			expect(md).toContain("- **ID**: obs-100");
			expect(md).toContain("- **Category**: bugfix");
			expect(md).toContain("- **Title**: Fixed memory leak");
			expect(md).toContain("- **Summary**: Cleaned up event listeners on session close.");
			expect(md).toContain("- **Files**: `src/event-bus.ts`");
			expect(md).toContain("- **Timestamp**: 2023-11-14T22:13:20.000Z");
			expect(md).toContain("- **Detail**:");
			expect(md).toContain("leakType");
		});

		it("formats search observation item cleanly", () => {
			const now = 1700000000000;
			const obs = {
				id: "obs-101",
				sessionId: "sess-1",
				entryId: null,
				turnIndex: 0,
				category: "discovery" as const,
				title: "Found config path",
				summary: "Config is stored under ~/.aery/config.json.",
				files: [],
				createdAt: now - 60000 * 2,
			};
			const item = formatSearchObservationItem(obs, now);
			expect(item).toContain("- **[`obs-101`]** (`discovery`) **Found config path** (2m ago)");
			expect(item).toContain("  - **Summary**: Config is stored under ~/.aery/config.json.");
			expect(item).toContain("  - **Files**: (none)");
		});

		it("formats list of search results", () => {
			const now = 1700000000000;
			const results = [
				{
					id: "obs-1",
					sessionId: "s1",
					entryId: null,
					turnIndex: 0,
					category: "feature" as const,
					title: "Feature One",
					summary: "Summary One",
					files: ["f1.ts"],
					createdAt: now - 10000,
				},
				{
					id: "obs-2",
					sessionId: "s1",
					entryId: null,
					turnIndex: 1,
					category: "bugfix" as const,
					title: "Bugfix Two",
					summary: "Summary Two",
					files: [],
					createdAt: now - 3600000,
				},
			];
			const md = formatSearchResultsMarkdown(results, now);
			expect(md).toContain("[`obs-1`]");
			expect(md).toContain("[`obs-2`]");
			expect(md).toContain("(just now)");
			expect(md).toContain("(1h ago)");
		});
	});

	describe("MemoryRecallTool", () => {
		it("recalls an existing observation by ID", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemoryRecallTool(session, store);

			const result = await tool.execute("call-1", { id: "obs-1" });
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const text = result.content[0].text;
			expect(text).toContain("### Observation: obs-1");
			expect(text).toContain("- **Category**: decision");
			expect(text).toContain("- **Title**: Adopted SQLite FTS5 for local memory");
			expect(text).toContain(
				"- **Summary**: Selected SQLite with FTS5 lexical search to achieve zero external dependencies.",
			);
			expect(text).toContain("- **Files**: `src/memory/store.ts`, `src/memory/schema.ts`");
			expect(text).toContain("- **Timestamp**:");
			expect(text).toContain("- **Detail**:");
			expect(text).toContain("offline-first architecture");
			expect(result.details.found).toBe(true);
			expect(result.details.observation.id).toBe("obs-1");
		});

		it("returns not found message when observation does not exist", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemoryRecallTool(session, store);

			const result = await tool.execute("call-2", { id: "obs-999" });
			expect(result.content).toHaveLength(1);
			expect(result.content[0].text).toBe('Observation "obs-999" not found in project memory.');
			expect(result.details.found).toBe(false);
		});

		it("handles observations with no files and no context", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemoryRecallTool(session, store);

			const result = await tool.execute("call-3", { id: "obs-4" });
			const text = result.content[0].text;
			expect(text).toContain("### Observation: obs-4");
			expect(text).toContain("- **Files**: (none)");
			expect(text).toContain("- **Detail**: (none)");
		});

		it("validates parameters against schema", () => {
			const session = createMockSession();
			const tool = new MemoryRecallTool(session, store);

			const valid = tool.parameters.safeParse({ id: "obs-123" });
			expect(valid.success).toBe(true);

			const invalid = tool.parameters.safeParse({});
			expect(invalid.success).toBe(false);

			const nonString = tool.parameters.safeParse({ id: 123 });
			expect(nonString.success).toBe(false);
		});

		it("resolves store from session.progressiveMemoryCoordinator", async () => {
			seedObservations();
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "coord-session",
				store,
			});
			const session = createMockSession({
				progressiveMemoryCoordinator: coordinator,
			});
			const tool = new MemoryRecallTool(session);

			const result = await tool.execute("call-coord", { id: "obs-1" });
			expect(result.content[0].text).toContain("Adopted SQLite FTS5");
		});

		it("resolves store from dbPath when coordinator is absent", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = new MemoryRecallTool(session);

			const result = await tool.execute("call-fallback", { id: "obs-2" });
			expect(result.content[0].text).toContain("Fixed sandbox EROFS test errors");
		});

		it("createIf factory returns tool or null based on settings", () => {
			const enabledSession = createMockSession();
			expect(MemoryRecallTool.createIf(enabledSession)).toBeInstanceOf(MemoryRecallTool);

			const disabledSession = createMockSession({
				settings: Settings.isolated({ "memory.progressive.enabled": false }),
			});
			expect(MemoryRecallTool.createIf(disabledSession)).toBeNull();
		});
	});

	describe("MemorySearchTool", () => {
		it("searches observations by natural language query", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemorySearchTool(session, store);

			const result = await tool.execute("call-s1", { query: "SQLite" });
			expect(result.content).toHaveLength(1);
			const text = result.content[0].text;
			expect(text).toContain("`obs-1`");
			expect(text).toContain("`decision`");
			expect(text).toContain("Adopted SQLite FTS5 for local memory");
			expect(text).toContain("Summary");
			expect(text).toContain("Files");
			expect(result.details.count).toBe(1);
			expect(result.details.results[0].id).toBe("obs-1");
		});

		it("filters search results by category", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemorySearchTool(session, store);

			// Search for "test" or "sandbox"
			const bugfixResult = await tool.execute("call-s2", {
				query: "sandbox",
				category: "bugfix",
			});
			expect(bugfixResult.details.count).toBe(1);
			expect(bugfixResult.details.results[0].id).toBe("obs-2");

			// Same query with different category filter returns 0 results
			const decisionResult = await tool.execute("call-s3", {
				query: "sandbox",
				category: "decision",
			});
			expect(decisionResult.content[0].text).toBe('No observations matching "sandbox" found in project memory.');
			expect(decisionResult.details.count).toBe(0);
		});

		it("respects limit parameter", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemorySearchTool(session, store);

			// Both obs-1 ("dependencies") and obs-3 ("checkpoint") match broad queries
			const limitedResult = await tool.execute("call-s4", {
				query: "for",
				limit: 1,
			});
			if (limitedResult.details.count > 0) {
				expect(limitedResult.details.results).toHaveLength(1);
			}
		});

		it("returns not found message when 0 results match", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemorySearchTool(session, store);

			const result = await tool.execute("call-s5", { query: "nonexistentkeywordxyz" });
			expect(result.content[0].text).toBe(
				'No observations matching "nonexistentkeywordxyz" found in project memory.',
			);
			expect(result.details.count).toBe(0);
			expect(result.details.results).toHaveLength(0);
		});

		it("handles empty or whitespace query gracefully", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemorySearchTool(session, store);

			const result = await tool.execute("call-s6", { query: "   " });
			expect(result.content[0].text).toBe('No observations matching "   " found in project memory.');
			expect(result.details.count).toBe(0);
		});

		it("validates parameters against schema", () => {
			const session = createMockSession();
			const tool = new MemorySearchTool(session, store);

			const valid = tool.parameters.safeParse({
				query: "find something",
				category: "feature",
				limit: 3,
			});
			expect(valid.success).toBe(true);

			const missingQuery = tool.parameters.safeParse({ category: "feature" });
			expect(missingQuery.success).toBe(false);

			const invalidCategory = tool.parameters.safeParse({
				query: "test",
				category: "invalid_category",
			});
			expect(invalidCategory.success).toBe(false);

			const negativeLimit = tool.parameters.safeParse({
				query: "test",
				limit: -1,
			});
			expect(negativeLimit.success).toBe(false);

			const zeroLimit = tool.parameters.safeParse({
				query: "test",
				limit: 0,
			});
			expect(zeroLimit.success).toBe(false);
		});

		it("createIf factory returns tool or null based on settings", () => {
			const enabledSession = createMockSession();
			expect(MemorySearchTool.createIf(enabledSession)).toBeInstanceOf(MemorySearchTool);

			const disabledSession = createMockSession({
				settings: Settings.isolated({ "memory.progressive.enabled": false }),
			});
			expect(MemorySearchTool.createIf(disabledSession)).toBeNull();
		});
	});

	describe("createTools() integration", () => {
		it("includes memory_recall and memory_search when memory.progressive.enabled is true", async () => {
			const session = createMockSession({
				settings: Settings.isolated({
					"memory.progressive.enabled": true,
				}),
			});

			const tools = await createTools(session);
			const names = tools.map(t => t.name);
			expect(names).toContain("memory_recall");
			expect(names).toContain("memory_search");
		});

		it("omits memory_recall and memory_search when memory.progressive.enabled is false", async () => {
			const session = createMockSession({
				settings: Settings.isolated({
					"memory.progressive.enabled": false,
				}),
			});

			const tools = await createTools(session);
			const names = tools.map(t => t.name);
			expect(names).not.toContain("memory_recall");
			expect(names).not.toContain("memory_search");
		});

		it("auto-includes memory_recall and memory_search when requestedTools is provided and enabled", async () => {
			const session = createMockSession({
				settings: Settings.isolated({
					"memory.progressive.enabled": true,
				}),
			});

			const tools = await createTools(session, ["read"]);
			const names = tools.map(t => t.name);
			expect(names).toContain("read");
			expect(names).toContain("memory_recall");
			expect(names).toContain("memory_search");
		});

		it("does not auto-include memory_recall or memory_search when requestedTools is provided and disabled", async () => {
			const session = createMockSession({
				settings: Settings.isolated({
					"memory.progressive.enabled": false,
				}),
			});

			const tools = await createTools(session, ["read"]);
			const names = tools.map(t => t.name);
			expect(names).toContain("read");
			expect(names).not.toContain("memory_recall");
			expect(names).not.toContain("memory_search");
		});
	});
});
