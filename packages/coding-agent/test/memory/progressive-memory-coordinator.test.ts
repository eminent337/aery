import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@aryee337/aery-ai";
import { createMockModel } from "@aryee337/aery-ai/providers/mock";
import { Agent } from "@aryee337/aery-core";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ObservationDistiller, type ToolExecutionRecord } from "../../src/memory/observation-distiller";
import { ProgressiveMemoryCoordinator, type TurnEndData } from "../../src/memory/progressive-memory-coordinator";
import { ProgressiveMemoryStore } from "../../src/memory/progressive-memory-store";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

describe("ProgressiveMemoryCoordinator", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-mem-coord-test-"));
		dbPath = path.join(tempDir, "test-memory.db");
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("initialization", () => {
		it("initializes with explicit store and distiller", () => {
			const store = new ProgressiveMemoryStore({ dbPath });
			const distiller = new ObservationDistiller();
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-1",
				store,
				distiller,
			});

			expect(coordinator.cwd).toBe(tempDir);
			expect(coordinator.sessionId).toBe("sess-1");
			expect(coordinator.getStore()).toBe(store);
			coordinator.close();
		});

		it("initializes with dbPath when store is omitted", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-2",
				dbPath,
			});

			expect(coordinator.cwd).toBe(tempDir);
			expect(coordinator.sessionId).toBe("sess-2");
			expect(coordinator.getStore()).toBeDefined();
			expect(coordinator.getStore().getObservationCount()).toBe(0);
			coordinator.close();
		});

		it("initializes with default dbPath relative to cwd", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-3",
			});

			const expectedPath = path.join(tempDir, ".aery", "memory", "project-memory.db");
			expect(fs.existsSync(expectedPath)).toBe(true);
			coordinator.close();
		});
	});

	describe("onTurnEnd", () => {
		it("captures and persists observations to SQLite store", async () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-turn-test",
				dbPath,
			});

			const toolExecutions: ToolExecutionRecord[] = [
				{
					toolName: "edit",
					params: {
						target_file: "packages/core/src/auth.ts",
					},
					resultText: "Successfully applied patch",
					isError: false,
				},
			];

			const turnData: TurnEndData = {
				turnIndex: 1,
				entryId: "entry-101",
				userPrompt: "fix the authentication token expiration bug",
				assistantText: "I fixed the token expiration bug in auth.ts",
				toolExecutions,
			};

			const records = await coordinator.onTurnEnd(turnData);

			expect(records.length).toBe(1);
			expect(records[0].category).toBe("bugfix");
			expect(records[0].sessionId).toBe("sess-turn-test");
			expect(records[0].entryId).toBe("entry-101");
			expect(records[0].turnIndex).toBe(1);
			expect(records[0].files).toContain("packages/core/src/auth.ts");

			// Verify persisted in store
			const store = coordinator.getStore();
			expect(store.getObservationCount()).toBe(1);
			const retrieved = store.getObservation(records[0].id);
			expect(retrieved).not.toBeNull();
			expect(retrieved?.summary).toBe(records[0].summary);

			coordinator.close();
		});

		it("returns empty array for turns with no notable observations", async () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-empty",
				dbPath,
			});

			const turnData: TurnEndData = {
				turnIndex: 2,
				userPrompt: "what time is it?",
				assistantText: "It is 10:00 AM.",
				toolExecutions: [],
			};

			const records = await coordinator.onTurnEnd(turnData);
			expect(records).toEqual([]);
			expect(coordinator.getStore().getObservationCount()).toBe(0);

			coordinator.close();
		});
	});

	describe("buildStartupPromptPrelude", () => {
		it("returns null when database has no observations", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-prelude-empty",
				dbPath,
			});

			const prelude = coordinator.buildStartupPromptPrelude();
			expect(prelude).toBeNull();

			coordinator.close();
		});

		it("formats observations into a compact Markdown table with relative age", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-prelude",
				dbPath,
			});
			const store = coordinator.getStore();

			const now = Date.now();
			// 10 minutes ago
			store.insertObservation({
				id: "obs-1",
				sessionId: "sess-old",
				turnIndex: 0,
				category: "bugfix",
				title: "Fixed sandbox EROFS test errors via HOME=/tmp",
				summary: "Fixed sandbox EROFS test errors by setting HOME=/tmp in bun test.",
				createdAt: now - 10 * 60 * 1000,
			});
			// 3 hours ago
			store.insertObservation({
				id: "obs-2",
				sessionId: "sess-old",
				turnIndex: 1,
				category: "decision",
				title: "Switched from git stash to isolated index files",
				summary: "Switched from git stash to isolated index files to prevent staging area conflicts.",
				createdAt: now - 3 * 3600 * 1000,
			});
			// 2 days ago
			store.insertObservation({
				id: "obs-3",
				sessionId: "sess-old",
				turnIndex: 2,
				category: "feature",
				title: "Added hidden-ref workspace checkpointing",
				summary: "Added hidden-ref workspace checkpointing for instant rollback.",
				createdAt: now - 2 * 86400 * 1000,
			});
			// Just now (10 seconds ago)
			store.insertObservation({
				id: "obs-4",
				sessionId: "sess-old",
				turnIndex: 3,
				category: "discovery",
				title: "Discovered Mnemopi database layout",
				summary: "Discovered Mnemopi stores embeddings in a separate table.",
				createdAt: now - 10 * 1000,
			});

			const prelude = coordinator.buildStartupPromptPrelude(5);
			expect(prelude).not.toBeNull();

			expect(prelude).toContain("### Recent Project Memory");
			expect(prelude).toContain("| ID | Type | Summary | Age |");
			expect(prelude).toContain("| :--- | :--- | :--- | :--- |");
			expect(prelude).toContain("| `obs-4` | `discovery` |");
			expect(prelude).toContain("just now");
			expect(prelude).toContain("10m ago");
			expect(prelude).toContain("3h ago");
			expect(prelude).toContain("2d ago");
			expect(prelude).toContain(
				"*Note: Use `memory_recall(id)` or `memory_search(query)` if full historical context is needed.*",
			);

			coordinator.close();
		});

		it("truncates summaries exceeding 100 characters in the table", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-truncate",
				dbPath,
			});
			const store = coordinator.getStore();

			const longSummary =
				"This is an extremely long summary explaining an architectural decision that exceeds one hundred characters by a wide margin and must be truncated.";
			store.insertObservation({
				id: "obs-long",
				sessionId: "sess-1",
				turnIndex: 0,
				category: "decision",
				title: "Long decision",
				summary: longSummary,
			});

			const prelude = coordinator.buildStartupPromptPrelude(5);
			expect(prelude).not.toBeNull();

			// Truncated summary must be <= 100 characters including ellipsis
			const row = prelude!.split("\n").find(line => line.includes("`obs-long`"));
			expect(row).toBeDefined();
			expect(row).toContain("...");
			// Verify raw long summary is not present verbatim
			expect(row).not.toContain(longSummary);

			coordinator.close();
		});

		it("escapes pipe characters and newlines in table summaries", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-pipe",
				dbPath,
			});
			const store = coordinator.getStore();

			store.insertObservation({
				id: "obs-pipe",
				sessionId: "sess-1",
				turnIndex: 0,
				category: "bugfix",
				title: "Pipe test",
				summary: "Fixed issue with option A | option B\nSecond line detail",
			});

			const prelude = coordinator.buildStartupPromptPrelude(5);
			expect(prelude).not.toBeNull();
			const row = prelude!.split("\n").find(line => line.includes("`obs-pipe`"));
			expect(row).toBeDefined();
			expect(row).toContain("option A \\| option B");
			expect(row).not.toContain("\nSecond line");

			coordinator.close();
		});
	});

	describe("closure", () => {
		it("closes store cleanly and prevents subsequent queries", () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-close",
				dbPath,
			});
			const store = coordinator.getStore();
			coordinator.close();

			expect(() => store.getObservationCount()).toThrow();
		});
	});

	describe("AgentSession integration", () => {
		let sessionDir: string;
		let authStorage: AuthStorage | undefined;

		beforeEach(async () => {
			sessionDir = path.join(tempDir, "session-test");
			fs.mkdirSync(sessionDir, { recursive: true });
			authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
		});

		afterEach(() => {
			authStorage?.close();
			authStorage = undefined;
		});

		it("initializes coordinator by default when enabled", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model not found");
			const modelRegistry = new ModelRegistry(authStorage!, path.join(sessionDir, "models.yml"));
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const settings = Settings.isolated();
			settings.set("memory.progressive.dbPath", path.join(sessionDir, "session-mem.db"));
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			expect(session.progressiveMemoryCoordinator).toBeDefined();
			session.beginDispose();
		});

		it("does not initialize coordinator when memory.progressive.enabled is false", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model not found");
			const modelRegistry = new ModelRegistry(authStorage!, path.join(sessionDir, "models.yml"));
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const settings = Settings.isolated();
			settings.set("memory.progressive.enabled", false);
			settings.set("memory.progressive.dbPath", path.join(sessionDir, "session-mem.db"));
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			expect(session.progressiveMemoryCoordinator).toBeUndefined();
			session.beginDispose();
		});

		it("returns empty array or null if store is closed", async () => {
			const coordinator = new ProgressiveMemoryCoordinator({
				cwd: tempDir,
				sessionId: "sess-closed",
				dbPath,
			});
			coordinator.close();

			const result = await coordinator.onTurnEnd({
				turnIndex: 0,
				assistantText: "Test response",
			});
			expect(result).toEqual([]);
			expect(coordinator.buildStartupPromptPrelude()).toBeNull();
		});

		it("captures observations when session executes a prompt turn", async () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model not found");
			const modelRegistry = new ModelRegistry(authStorage!, path.join(sessionDir, "models.yml"));
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "text",
								text: "Decided to adopt PostgreSQL for persistence layer to support relational integrity.",
							},
						],
					},
				],
			});
			const agent = new Agent({
				initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const settings = Settings.isolated();
			settings.set("memory.progressive.dbPath", path.join(sessionDir, "prompt-turn-mem.db"));
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			await session.prompt("Which database should we choose?");

			// Allow microtask queue / event emission
			await Bun.sleep(50);

			const store = session.progressiveMemoryCoordinator!.getStore();
			expect(store.getObservationCount()).toBeGreaterThanOrEqual(1);
			const recent = store.listRecentObservations(5);
			expect(recent[0].category).toBe("decision");
			expect(recent[0].summary).toContain("PostgreSQL");

			session.beginDispose();
		});

		it("disposes coordinator on session dispose", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model not found");
			const modelRegistry = new ModelRegistry(authStorage!, path.join(sessionDir, "models.yml"));
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const settings = Settings.isolated();
			settings.set("memory.progressive.dbPath", path.join(sessionDir, "session-mem.db"));
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			const coord = session.progressiveMemoryCoordinator;
			expect(coord).toBeDefined();
			const store = coord!.getStore();
			expect(store.isClosed).toBe(false);

			session.beginDispose();
			expect(store.isClosed).toBe(true);
		});
	});
});
