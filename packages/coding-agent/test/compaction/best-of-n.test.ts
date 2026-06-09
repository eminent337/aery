import { describe, expect, test } from "bun:test";
import { BestOfNSelector, type Candidate } from "../../src/compaction/best-of-n";

describe("BestOfNSelector", () => {
	const makeCandidate = (id: string, score: number): Candidate<string> => ({
		id,
		content: `content-${id}`,
		score,
	});

	test("selects highest score", () => {
		const selector = new BestOfNSelector();
		const candidates = [makeCandidate("a", 5), makeCandidate("b", 10), makeCandidate("c", 3)];
		const result = selector.select(candidates);
		expect(result?.id).toBe("b");
	});

	test("handles ties (prefer first by default)", () => {
		const selector = new BestOfNSelector();
		const candidates = [makeCandidate("first", 10), makeCandidate("second", 10), makeCandidate("third", 10)];
		const result = selector.select(candidates);
		expect(result?.id).toBe("first");
	});

	test("prefer later on tie when configured", () => {
		const selector = new BestOfNSelector({ preferFirstOnTie: false });
		const candidates = [makeCandidate("first", 10), makeCandidate("second", 10), makeCandidate("third", 10)];
		const result = selector.select(candidates);
		expect(result?.id).toBe("third");
	});

	test("filters below minScore", () => {
		const selector = new BestOfNSelector({ minScore: 5 });
		const candidates = [makeCandidate("low", 2), makeCandidate("mid", 5), makeCandidate("high", 10)];
		const result = selector.select(candidates);
		expect(result?.id).toBe("high");
	});

	test("returns undefined for empty array", () => {
		const selector = new BestOfNSelector();
		const result = selector.select([]);
		expect(result).toBeUndefined();
	});

	test("returns undefined when all below minScore", () => {
		const selector = new BestOfNSelector({ minScore: 10 });
		const candidates = [makeCandidate("a", 5), makeCandidate("b", 3)];
		const result = selector.select(candidates);
		expect(result).toBeUndefined();
	});

	test("rank returns descending order", () => {
		const selector = new BestOfNSelector();
		const candidates = [makeCandidate("a", 5), makeCandidate("b", 10), makeCandidate("c", 3)];
		const result = selector.rank(candidates);
		expect(result.map(c => c.id)).toEqual(["b", "a", "c"]);
	});
});
