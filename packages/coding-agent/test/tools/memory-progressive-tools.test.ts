import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@aryee337/aery-core";
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

function getText(result: AgentToolResult): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

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
		} as ToolSession;
	}

	function seedObservations() {
		store.insertObservation({
			id: "obs-1",
			sessionId: "test-session",
			turnIndex: 0,
			category: "decision",
			title: "Adopted SQLite FTS5 for local memory",
			summary: "Selected SQLite with FTS5 lexical search to achieve zero external dependencies.",
			files: ["src/memory/store.ts", "src/memory/schema.ts"],
			context: { rationale: "offline-first architecture", benchmarkMs: 2.4 },
			createdAt: Date.now() - 3600 * 1000 * 2, // 2h ago
		});

		store.insertObservation({
			id: "obs-2",
			sessionId: "test-session",
			turnIndex: 1,
			category: "bugfix",
			title: "Fixed sandbox EROFS test errors",
			summary: "Resolved sandbox test failures by passing HOME=/tmp environment variable.",
			files: ["test/memory/store.test.ts"],
			context: { fix: "export HOME=/tmp before running bun test" },
			createdAt: Date.now() - 3600 * 1000 * 5, // 5h ago
		});

		store.insertObservation({
			id: "obs-3",
			sessionId: "test-session",
			turnIndex: 2,
			category: "feature",
			title: "Implemented hidden-ref git checkpoints",
			summary: "Added checkpoint tool to save workspace states under hidden git refs.",
			files: ["src/tools/checkpoint.ts"],
			createdAt: Date.now() - 3600 * 1000 * 24 * 2, // 2d ago
		});

		store.insertObservation({
			id: "obs-4",
			sessionId: "test-session",
			turnIndex: 3,
			category: "discovery",
			title: "Discovered existing mnemopi session protocol",
			summary: "Mnemopi backend supports scoped recall results via session manager.",
			createdAt: Date.now() - 1000 * 30, // 30s ago
		});
	}

	describe("formatters", () => {
		it("formats relative age accurately", () => {
			const now = 10000000;
			expect(formatRelativeAge(now - 30 * 1000, now)).toBe("just now");
			expect(formatRelativeAge(now - 5 * 60 * 1000, now)).toBe("5m ago");
			expect(formatRelativeAge(now - 3 * 3600 * 1000, now)).toBe("3h ago");
			expect(formatRelativeAge(now - 48 * 3600 * 1000, now)).toBe("2d ago");
		});

		it("formats full observation markdown", () => {
			const markdown = formatObservationMarkdown({
				id: "obs-test",
				sessionId: "sess-test",
				entryId: null,
				turnIndex: 0,
				category: "bugfix",
				title: "Fixed race condition",
				summary: "Resolved concurrency issue in async task worker.",
				files: ["src/worker.ts"],
				context: { threadCount: 4 },
				createdAt: 1700000000000,
			});

			expect(markdown).toContain("### Observation: obs-test");
			expect(markdown).toContain("- **ID**: obs-test");
			expect(markdown).toContain("- **Category**: bugfix");
			expect(markdown).toContain("- **Title**: Fixed race condition");
			expect(markdown).toContain("- **Summary**: Resolved concurrency issue in async task worker.");
			expect(markdown).toContain("- **Files**: `src/worker.ts`");
			expect(markdown).toContain("- **Timestamp**: 2023-11-14T22:13:20.000Z");
			expect(markdown).toContain('"threadCount": 4');
		});

		it("formats search result items", () => {
			const item = formatSearchObservationItem(
				{
					id: "obs-item",
					sessionId: "sess-test",
					entryId: null,
					turnIndex: 0,
					category: "feature",
					title: "Added tool",
					summary: "New tool created",
					files: ["src/tool.ts"],
					createdAt: Date.now() - 120000,
				},
				Date.now(),
			);

			expect(item).toContain("- **[`obs-item`]** (`feature`) **Added tool** (2m ago)");
			expect(item).toContain("- **Summary**: New tool created");
			expect(item).toContain("- **Files**: `src/tool.ts`");
		});

		it("formats multiple search results", () => {
			const markdown = formatSearchResultsMarkdown(
				[
					{
						id: "obs-a",
						sessionId: "sess-test",
						entryId: null,
						turnIndex: 0,
						files: [],
						category: "discovery",
						title: "Item A",
						summary: "Summary A",
						createdAt: Date.now(),
					},
					{
						id: "obs-b",
						sessionId: "sess-test",
						entryId: null,
						turnIndex: 0,
						files: [],
						category: "decision",
						title: "Item B",
						summary: "Summary B",
						createdAt: Date.now(),
					},
				],
				Date.now(),
			);

			expect(markdown).toContain("`obs-a`");
			expect(markdown).toContain("`obs-b`");
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
			const text = getText(result);
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
			expect(getText(result)).toBe('Observation "obs-999" not found in project memory.');
			expect(result.details.found).toBe(false);
		});

		it("handles observations with no files and no context", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemoryRecallTool(session, store);

			const result = await tool.execute("call-3", { id: "obs-4" });
			const text = getText(result);
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
			expect(getText(result)).toContain("Adopted SQLite FTS5");
			tool.dispose();
		});

		it("resolves store from dbPath when coordinator is absent", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = new MemoryRecallTool(session);

			const result = await tool.execute("call-fallback", { id: "obs-2" });
			expect(getText(result)).toContain("Fixed sandbox EROFS test errors");
			tool.dispose();
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
			const text = getText(result);
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
			expect(getText(decisionResult)).toBe('No observations matching "sandbox" found in project memory.');
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
			expect(getText(result)).toBe('No observations matching "nonexistentkeywordxyz" found in project memory.');
			expect(result.details.count).toBe(0);
			expect(result.details.results).toHaveLength(0);
		});

		it("handles empty or whitespace query gracefully", async () => {
			seedObservations();
			const session = createMockSession();
			const tool = createMemorySearchTool(session, store);

			const result = await tool.execute("call-s6", { query: "   " });
			expect(getText(result)).toBe('No observations matching "   " found in project memory.');
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

		it("includes memory_recall and memory_search when explicitly requested in toolNames", async () => {
			const session = createMockSession({
				settings: Settings.isolated({
					"memory.progressive.enabled": true,
				}),
			});

			const tools = await createTools(session, ["read", "memory_recall"]);
			const names = tools.map(t => t.name);
			expect(names).toContain("read");
			expect(names).toContain("memory_recall");
			expect(names).not.toContain("memory_search");
		});

		it("respects restricted requested tool subsets", async () => {
			const session = createMockSession({
				settings: Settings.isolated({
					"memory.progressive.enabled": true,
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
