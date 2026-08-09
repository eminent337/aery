import { describe, expect, it, spyOn } from "bun:test";
import {
	buildHarnessBlock,
	buildHarnessRecallBlock,
	recallHarnessEntries,
	scoreHarnessEntry,
	DEFAULT_MIN_SCORE,
	DEFAULT_THRESHOLD,
} from "../src/continual-harness/inject.js";
import type { HarnessEntry } from "../src/continual-harness/types.js";

const entry = (id: string, kind: HarnessEntry["kind"], title: string, content: string): HarnessEntry => ({
	id, kind, title, content, path: "", scope: "local",
	reference: {}, arguments: {}, metadata: {}, source: "test",
	created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
});

const state = {
	schema: 1,
	entries: {
		prompt: { p1: entry("p1", "prompt", "Git commit conventions", "Write conventional commit messages") },
		memory: {
			m1: entry("m1", "memory", "Project uses Bun", "The repo uses bun test with --timeout 60000"),
			m2: entry("m2", "memory", "Deploy process", "Deploy via flyctl to production"),
		},
		skill: { s1: entry("s1", "skill", "Run tests", "Use bun test <file> --timeout 60000") },
		subagent: {},
	},
	refinements: [],
} satisfies { schema: number; entries: Record<string, Record<string, HarnessEntry>>; refinements: unknown[] };

describe("harness injection", () => {
	it("builds a block with all kinds", () => {
		const block = buildHarnessBlock(state, 0)!;
		expect(block).toContain("<harness>");
		expect(block).toContain("Prompt entries");
		expect(block).toContain("Memory entries");
		expect(block).toContain("Skill entries");
		expect(block).toContain("Git commit conventions");
	});

	it("returns undefined for empty state", () => {
		const empty = { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
		expect(buildHarnessBlock(empty as unknown as typeof state, 0)).toBeUndefined();
	});

	it("token caps the block", () => {
		const block = buildHarnessBlock(state, 1)!;
		expect(block.length).toBeLessThanOrEqual(4 + 1);
	});

	it("scores relevant entries higher", () => {
		const s1 = scoreHarnessEntry(state.entries.memory.m1, "how do i run bun tests?");
		const s2 = scoreHarnessEntry(state.entries.memory.m2, "how do i run bun tests?");
		expect(s1).toBeGreaterThan(s2);
	});

	it("recall returns only relevant entries above threshold", () => {
		const recalled = recallHarnessEntries(state, "run bun tests", 0);
		const titles = recalled.map((e) => e.title);
		expect(titles).toContain("Run tests");
		expect(titles).not.toContain("Deploy process");
	});

	it("recall with minScore filters low-scoring entries", () => {
		const recalled = recallHarnessEntries(state, "run bun tests", 0, 3);
		const titles = recalled.map((e) => e.title);
		expect(titles).toContain("Run tests");
	});

	it("recall block falls back to top-N on empty query", () => {
		const block = buildHarnessRecallBlock(state, "", 0)!;
		expect(block).toContain("Git commit conventions");
	});

	it("zero token limit means no cap", () => {
		const uncapped = buildHarnessBlock(state, 0)!;
		expect(uncapped).toContain("Deploy process");
		const tiny = buildHarnessBlock(state, 1)!;
		expect(tiny).not.toContain("Deploy process");
	});

	it("status injected-count matches block entries", () => {
		const block = buildHarnessBlock(state, 5000)!;
		const injectedCount = (block.match(/^- /gm) ?? []).length;
		expect(injectedCount).toBe(4);
	});

	it("threshold parameter excludes low-scoring entries", () => {
		const recalled = recallHarnessEntries(state, "run bun tests", 0, DEFAULT_MIN_SCORE, 10);
		expect(recalled).toHaveLength(0);
	});

	it("logs injection events", () => {
		const logSpy = spyOn(console, "debug").mockImplementation(() => {});
		buildHarnessRecallBlock(state, "run bun tests", 0);
		expect(logSpy.calls.length).toBeGreaterThan(0);
		logSpy.mockRestore();
	});
});
