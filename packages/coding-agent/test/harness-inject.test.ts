import { describe, expect, it } from "bun:test";
import { buildHarnessBlock, buildHarnessRecallBlock, recallHarnessEntries, scoreHarnessEntry } from "../src/continual-harness/inject.js";

const entry = (id: string, kind: any, title: string, content: string) => ({
	id, kind, title, content, path: "", scope: "local" as const,
	reference: {}, arguments: {}, metadata: {}, source: "test",
	created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
});

const state: any = {
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
};

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
		expect(buildHarnessBlock(empty as any, 0)).toBeUndefined();
	});

	it("token caps the block", () => {
		const block = buildHarnessBlock(state, 1)!;
		expect(block.length).toBeLessThanOrEqual(4 + 1); // 1 token * 4 chars + ellipsis
	});

	it("scores relevant entries higher", () => {
		const s1 = scoreHarnessEntry(state.entries.memory.m1, "how do i run bun tests?");
		const s2 = scoreHarnessEntry(state.entries.memory.m2, "how do i run bun tests?");
		expect(s1).toBeGreaterThan(s2);
	});

	it("recall returns only relevant entries", () => {
		const recalled = recallHarnessEntries(state, "run bun tests", 0);
		const titles = recalled.map((e: any) => e.title);
		expect(titles).toContain("Project uses Bun");
		expect(titles).toContain("Run tests");
		expect(titles).not.toContain("Deploy process");
	});

	it("recall block falls back to top-N on empty query", () => {
		const block = buildHarnessRecallBlock(state, "", 0)!;
		expect(block).toContain("Git commit conventions");
	});
	it("zero token limit means no cap", () => {
		const uncapped = buildHarnessBlock(state, 0)!;
		expect(uncapped).toContain("Deploy process"); // all entries present
		const tiny = buildHarnessBlock(state, 1)!;
		expect(tiny).not.toContain("Deploy process"); // capped drops later entries
	});
	it("status injected-count matches block entries", () => {
		// Mirrors /refine status: count of "- " lines in the preview block.
		const block = buildHarnessBlock(state, 5000)!;
		const injectedCount = (block.match(/^- /gm) ?? []).length;
		expect(injectedCount).toBe(4); // p1, m1, m2, s1
	});
});
