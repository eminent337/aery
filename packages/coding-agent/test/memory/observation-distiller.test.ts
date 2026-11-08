import { beforeEach, describe, expect, it } from "bun:test";
import { type DistillTurnInput, ObservationDistiller } from "../../src/memory/observation-distiller";

describe("ObservationDistiller", () => {
	let distiller: ObservationDistiller;

	beforeEach(() => {
		distiller = new ObservationDistiller();
	});

	describe("trivial read-only turns", () => {
		it("ignores turns with only read and search tools", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 1,
				userPrompt: "Where is the memory store implemented?",
				toolExecutions: [
					{
						toolName: "find",
						params: { pattern: "memory" },
						resultText: "packages/coding-agent/src/memory",
					},
					{
						toolName: "read_file",
						params: { path: "packages/coding-agent/src/memory/types.ts" },
						resultText: "export type ObservationCategory...",
					},
					{
						toolName: "search",
						params: { query: "ObservationCategory" },
						resultText: "found 1 match",
					},
				],
				assistantText: "The memory store types are defined in types.ts.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(0);
		});

		it("ignores turns with empty tool executions and conversational banter", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 2,
				userPrompt: "Hello, can you help me today?",
				assistantText: "Hello! I am ready to assist you with your project.",
				toolExecutions: [],
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(0);
		});

		it("ignores non-modifying bash commands like ls or git status", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 3,
				userPrompt: "Check git status",
				toolExecutions: [
					{
						toolName: "run_command",
						params: { CommandLine: "git status" },
						resultText: "On branch main\nnothing to commit",
						isError: false,
					},
					{
						toolName: "bash",
						params: { command: "ls -la" },
						resultText: "total 12",
						isError: false,
					},
				],
				assistantText: "Working tree is clean.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(0);
		});
	});

	describe("file modification categorization", () => {
		it("detects bugfix from file edit when user prompt mentions error or fix", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 4,
				userPrompt: "Fix the crash when parsing malformed JSON in memory store",
				toolExecutions: [
					{
						toolName: "edit_file",
						params: { Path: "packages/coding-agent/src/memory/progressive-memory-store.ts" },
						resultText: "applied edit",
					},
				],
				assistantText: "Fixed JSON parsing in progressive memory store.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("bugfix");
			expect(observations[0].title).toBe("Fixed progressive-memory-store.ts");
			expect(observations[0].files).toEqual(["packages/coding-agent/src/memory/progressive-memory-store.ts"]);
		});

		it("detects bugfix when a previous tool in the turn had isError: true", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 5,
				userPrompt: "Run tests and resolve issues",
				toolExecutions: [
					{
						toolName: "run_command",
						params: { CommandLine: "bun test" },
						isError: true,
						resultText: "SyntaxError: Unexpected token",
					},
					{
						toolName: "edit",
						params: { path: "src/server.ts" },
						resultText: "edited",
					},
				],
				assistantText: "Resolved the syntax error in server.ts.",
			};

			const observations = distiller.distillFromTurn(input);
			const bugfixes = observations.filter(o => o.category === "bugfix");
			expect(bugfixes.length).toBeGreaterThanOrEqual(1);
			const fileObs = bugfixes.find(o => o.files?.includes("src/server.ts"));
			expect(fileObs).toBeDefined();
			expect(fileObs?.title).toBe("Fixed server.ts");
		});

		it("detects decision when modifying configuration files", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 6,
				userPrompt: "Add sqlite dependency to configuration",
				toolExecutions: [
					{
						toolName: "edit_file",
						params: { Path: "package.json" },
						resultText: "edited",
					},
				],
				assistantText: "Added sqlite dependency to package.json.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("decision");
			expect(observations[0].title).toBe("Updated package.json");
			expect(observations[0].files).toEqual(["package.json"]);
		});

		it("detects feature from normal file writes or edits", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 7,
				userPrompt: "Implement progressive memory observation distiller",
				toolExecutions: [
					{
						toolName: "write_file",
						params: { Path: "packages/coding-agent/src/memory/observation-distiller.ts" },
						resultText: "written",
					},
				],
				assistantText: "Created the ObservationDistiller implementation.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("feature");
			expect(observations[0].title).toBe("Updated observation-distiller.ts");
			expect(observations[0].files).toEqual(["packages/coding-agent/src/memory/observation-distiller.ts"]);
		});
	});

	describe("command execution categorization", () => {
		it("detects bugfix when test runner succeeds after failure", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 8,
				userPrompt: "Fix the failing tests",
				toolExecutions: [
					{
						toolName: "run_command",
						params: { CommandLine: "bun test" },
						isError: true,
						resultText: "1 fail",
					},
					{
						toolName: "run_command",
						params: { CommandLine: "bun test" },
						isError: false,
						resultText: "13 pass, 0 fail",
					},
				],
				assistantText: "All tests are now passing.",
			};

			const observations = distiller.distillFromTurn(input);
			const bugfixObs = observations.filter(o => o.category === "bugfix");
			expect(bugfixObs.length).toBeGreaterThanOrEqual(1);
			expect(bugfixObs[0].title).toContain("bun test");
		});

		it("detects decision when installing package dependencies", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 9,
				userPrompt: "Install fast-glob",
				toolExecutions: [
					{
						toolName: "run_command",
						params: { CommandLine: "bun add fast-glob" },
						isError: false,
						resultText: "installed fast-glob",
					},
				],
				assistantText: "Installed fast-glob package.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("decision");
			expect(observations[0].title).toContain("dependencies");
		});
	});

	describe("explicit keyword detection", () => {
		it("detects decision from assistant thinking ('Decided to use SQLite FTS5 for local search')", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 10,
				assistantThinking: "Decided to use SQLite FTS5 for local search",
				assistantText: "I will proceed with implementing the search engine using SQLite FTS5.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("decision");
			expect(observations[0].title).toBe("Decided to use SQLite FTS5 for local search");
		});

		it("detects decision from assistant text with architectural decision pattern", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 11,
				assistantText: "Architectural decision: Use isolated GIT_INDEX_FILE for checkpoints",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("decision");
			expect(observations[0].title).toBe("Use isolated GIT_INDEX_FILE for checkpoints");
		});

		it("detects discovery from assistant text ('Discovered that Aery uses Mnemopi for memory')", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 12,
				assistantText: "Discovered that Aery uses Mnemopi for memory.",
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].category).toBe("discovery");
			expect(observations[0].title).toBe("Discovered that Aery uses Mnemopi for memory");
		});
	});

	describe("file paths extraction across multiple tools in one turn", () => {
		it("extracts file paths across multiple distinct tools in one turn", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 13,
				userPrompt: "Refactor memory interfaces",
				toolExecutions: [
					{
						toolName: "edit",
						params: { path: "src/memory/types.ts" },
						resultText: "edited",
					},
					{
						toolName: "write",
						params: { filePath: "src/memory/observation-distiller.ts" },
						resultText: "written",
					},
					{
						toolName: "ast_edit",
						params: { file: "src/memory/progressive-memory-store.ts" },
						resultText: "transformed",
					},
				],
				assistantText: "Refactored memory interfaces and components.",
			};

			const observations = distiller.distillFromTurn(input);
			const allFiles = observations.flatMap(o => o.files ?? []);
			expect(allFiles).toContain("src/memory/types.ts");
			expect(allFiles).toContain("src/memory/observation-distiller.ts");
			expect(allFiles).toContain("src/memory/progressive-memory-store.ts");
		});
	});

	describe("deduplication within the turn", () => {
		it("deduplicates observations when the same file is modified multiple times in one turn", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 14,
				userPrompt: "Update memory store implementation",
				toolExecutions: [
					{
						toolName: "edit",
						params: { path: "src/memory/store.ts" },
						resultText: "edit 1",
					},
					{
						toolName: "edit_file",
						params: { Path: "src/memory/store.ts" },
						resultText: "edit 2",
					},
					{
						toolName: "write",
						params: { filePath: "src/memory/store.ts" },
						resultText: "edit 3",
					},
				],
				assistantText: "Updated store.ts multiple times.",
			};

			const observations = distiller.distillFromTurn(input);
			const storeObservations = observations.filter(o => o.files?.includes("src/memory/store.ts"));
			expect(storeObservations).toHaveLength(1);
		});

		it("deduplicates identical decisions appearing in both thinking and text", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 15,
				assistantThinking: "Decided to use SQLite FTS5 for local search",
				assistantText: "Decided to use SQLite FTS5 for local search for performance.",
			};

			const observations = distiller.distillFromTurn(input);
			const decisions = observations.filter(o => o.category === "decision");
			expect(decisions).toHaveLength(1);
		});
	});

	describe("formatting constraints", () => {
		it("caps title length to 80 characters without unicode dashes", () => {
			const longTitle =
				"Decided to use SQLite FTS5 for local search because full-text search requires fast token indexing and sqlite provides built-in BM25 ranking algorithm";
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 16,
				assistantThinking: longTitle,
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].title.length).toBeLessThanOrEqual(80);
			expect(observations[0].title).not.toContain("\u2013");
			expect(observations[0].title).not.toContain("\u2014");
		});

		it("produces clean 1-2 sentence summaries", () => {
			const input: DistillTurnInput = {
				sessionId: "sess-1",
				turnIndex: 17,
				userPrompt: "Fix null pointer crash in server",
				toolExecutions: [
					{
						toolName: "edit",
						params: { path: "src/server.ts" },
						resultText: "ok",
					},
				],
			};

			const observations = distiller.distillFromTurn(input);
			expect(observations).toHaveLength(1);
			expect(observations[0].summary.length).toBeGreaterThan(0);
			expect(observations[0].summary).toMatch(/[.!?]$/);
		});
	});
});
