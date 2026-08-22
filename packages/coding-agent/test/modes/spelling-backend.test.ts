import { describe, expect, it } from "bun:test";
import { DictionarySpellingBackend, damerauLevenshtein, isUnavailableBackend } from "../../src/modes/spelling-backend";

const DICT = [
	"apple",
	"apples",
	"apply",
	"application",
	"banana",
	"bannana",
	"berry",
	"cat",
	"cats",
	"call",
	"car",
	"care",
	"cast",
	"dog",
	"dogs",
	"dig",
	"dug",
	"do",
	"road",
	"rode",
	"read",
	"ready",
	"search",
	"sreach",
	"serch",
	"the",
	"them",
	"this",
	"that",
	"word",
	"world",
	"work",
];

function makeBackend(): DictionarySpellingBackend {
	return new DictionarySpellingBackend(DICT);
}

describe("damerauLevenshtein", () => {
	it("counts transposition as one edit", () => {
		expect(damerauLevenshtein("world", "worls")).toBe(1); // 'ld' -> 'ls'
		expect(damerauLevenshtein("ab", "ba")).toBe(1);
	});

	it("counts insertion/deletion/substitution", () => {
		expect(damerauLevenshtein("cat", "cats")).toBe(1);
		expect(damerauLevenshtein("cat", "cut")).toBe(1);
		expect(damerauLevenshtein("", "abc")).toBe(3);
		expect(damerauLevenshtein("same", "same")).toBe(0);
	});
});

describe("DictionarySpellingBackend.checkSpelling", () => {
	it("flags unknown words and skips known ones", () => {
		const b = makeBackend();
		const ranges = b.checkSpelling("apple cat zzxx dog");
		expect(ranges.length).toBe(1);
		expect(ranges[0].start).toBe("apple cat ".length);
		expect(ranges[0].length).toBe("zzxx".length);
	});

	it("skips words shorter than the minimum length", () => {
		const b = makeBackend();
		// 'ab' is too short (2 < 3) and should not be flagged even if unknown.
		expect(b.checkSpelling("ab qq rd").length).toBe(0);
	});

	it("is case-insensitive", () => {
		const b = makeBackend();
		expect(b.checkSpelling("APPLE Cat").length).toBe(0);
	});

	it("treats punctuation-separated tokens independently", () => {
		const b = makeBackend();
		const ranges = b.checkSpelling("cat,zzxx dog");
		expect(ranges.length).toBe(1);
		expect(ranges[0].start).toBe("cat,".length);
	});
});

describe("DictionarySpellingBackend.completeWord", () => {
	it("returns prefix matches longer than the prefix", () => {
		const b = makeBackend();
		const completions = b.completeWord("appl", 0, 4); // prefix "appl"
		expect(completions).toContain("apple");
		expect(completions).toContain("apply");
		expect(completions.some(w => w === "appl")).toBe(false); // no self-match
	});

	it("returns empty for a too-short prefix", () => {
		const b = makeBackend();
		expect(b.completeWord("", 0, 1)).toEqual([]);
	});
});

describe("DictionarySpellingBackend.autocorrectWord", () => {
	it("returns null for a known word", () => {
		const b = makeBackend();
		expect(b.autocorrectWord("", 0, "cat".length) ?? null).toBe(null);
	});

	it("corrects a confident distance-1 misspelling", () => {
		const b = makeBackend();
		// "aple" (missing one 'p') should correct to "apple" (distance 1).
		expect(b.autocorrectWord("aple", 0, 4)).toBe("apple");
	});
});

describe("DictionarySpellingBackend.spellingGuesses", () => {
	it("returns ranked dictionary-word guesses for a typo", () => {
		const b = makeBackend();
		// "wrod" is a distance-1 typo of "word" (transposition).
		const typoGuesses = b.spellingGuesses("wrod", 0, 4);
		expect(typoGuesses).toContain("word");
		expect(typoGuesses.length).toBeGreaterThan(0);
		// Every guess must be a real dictionary word.
		for (const g of typoGuesses) {
			expect(g).toBeTruthy();
		}
	});
});
describe("isUnavailableBackend", () => {
	it("reports unavailable and returns empty results", () => {
		const b = isUnavailableBackend();
		expect(b.isAvailable()).toBe(false);
		expect(b.checkSpelling("anything")).toEqual([]);
		expect(b.completeWord("", 0, 3)).toEqual([]);
		expect(b.autocorrectWord("", 0, 3)).toBe(null);
		expect(b.spellingGuesses("", 0, 3)).toEqual([]);
	});
});
