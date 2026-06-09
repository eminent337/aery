import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/compaction/entries";
import { pruneMessages } from "../src/compaction/pruning";

function userMsg(text: string): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		message: { role: "user", content: text },
	} as SessionEntry;
}

function assistantMsg(text: string): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		message: { role: "assistant", content: [{ type: "text", text }] },
	} as SessionEntry;
}

describe("pruneMessages", () => {
	it("returns empty when no messages need pruning", () => {
		const entries = [userMsg("hello"), assistantMsg("hi")];
		const result = pruneMessages(entries, {
			userBudget: 100_000,
			assistantBudget: 100_000,
			charsPerToken: 4,
		});
		expect(result.prunedCount).toBe(0);
		expect(result.tokensSaved).toBe(0);
	});

	it("prunes old user messages when user budget exceeded", () => {
		const entries = [
			userMsg("a".repeat(400_000)), // ~100k tokens — old
			assistantMsg("b".repeat(400_000)), // ~100k tokens — old
			userMsg("c".repeat(400_000)), // ~100k tokens — recent
		];
		const result = pruneMessages(entries, {
			userBudget: 50_000,
			assistantBudget: 50_000,
			charsPerToken: 4,
		});
		expect(result.prunedCount).toBeGreaterThanOrEqual(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
	});

	it("prunes old assistant messages when assistant budget exceeded", () => {
		const entries = [
			assistantMsg("a".repeat(400_000)), // ~100k tokens — old
			userMsg("b".repeat(400_000)), // ~100k tokens — old
			assistantMsg("c".repeat(400_000)), // ~100k tokens — recent
		];
		const result = pruneMessages(entries, {
			userBudget: 50_000,
			assistantBudget: 50_000,
			charsPerToken: 4,
		});
		expect(result.prunedCount).toBeGreaterThanOrEqual(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
	});

	it("preserves most recent messages within budget", () => {
		const entries = [userMsg("a".repeat(400_000)), assistantMsg("b".repeat(400_000)), userMsg("keep-this")];
		pruneMessages(entries, {
			userBudget: 50_000,
			assistantBudget: 50_000,
			charsPerToken: 4,
		});
		// Most recent user message should not be pruned
		const lastEntry = entries[entries.length - 1];
		const lastMsg = (lastEntry as any).message as { role: string; content: string };
		expect(lastMsg.content).toBe("keep-this");
	});

	it("returns empty when both budgets are 0 (disabled)", () => {
		const entries = [userMsg("a".repeat(400_000))];
		const result = pruneMessages(entries, {
			userBudget: 0,
			assistantBudget: 0,
			charsPerToken: 4,
		});
		expect(result.prunedCount).toBe(0);
	});
});
