/**
 * Pure-TS spelling backend for Aery.
 *
 * Implements the {@link SpellingBackend} contract used by the editor's
 * text-assist provider entirely in TypeScript — no Rust natives, no macOS
 * AppKit dependency — so typo detection, word completion, and autocorrect
 * work identically on Linux, macOS, and Windows using a bundled dictionary.
 *
 * Suggestion ranking uses Damerau-Levenshtein edit distance (transpositions
 * count as one error) with a light frequency/prefix boost so common words
 * win ties.
 */
import { DEFAULT_SPELLING_WORDLIST } from "./spelling-wordlist";

/** One misspelled span measured in JS/UTF-16 code units (mirrors omp's native shape). */
export interface SpellingRange {
	start: number;
	length: number;
}

/** Dictionary operations the spelling provider needs from its backend. */
export interface SpellingBackend {
	isAvailable(): boolean;
	checkSpelling(text: string): SpellingRange[];
	completeWord(text: string, start: number, length: number): string[];
	autocorrectWord(text: string, start: number, length: number): string | null;
	spellingGuesses(text: string, start: number, length: number): string[];
}

const MAX_EDIT_DISTANCE = 2;
const MAX_SUGGESTIONS = 10;
const MIN_WORD_LENGTH = 3;

/** Common words ranked first when edit-distance ties occur. */
const FREQUENT_WORDS = new Set<string>([
	"the",
	"of",
	"and",
	"to",
	"in",
	"a",
	"is",
	"that",
	"for",
	"it",
	"on",
	"with",
	"as",
	"be",
	"this",
	"have",
	"from",
	"or",
	"at",
	"was",
	"are",
	"they",
	"you",
	"your",
	"not",
	"will",
	"can",
	"but",
	"what",
	"all",
	"when",
	"we",
	"there",
	"which",
	"their",
	"about",
	"would",
	"if",
	"so",
	"then",
	"she",
	"he",
	"one",
	"no",
	"just",
	"because",
	"out",
	"some",
	"them",
	"make",
	"get",
	"do",
	"could",
	"new",
	"first",
	"may",
	"any",
	"now",
	"work",
	"these",
	"see",
	"people",
	"know",
	"two",
	"like",
	"more",
	"after",
	"into",
	"than",
	"our",
	"other",
	"well",
	"been",
	"most",
	"where",
	"much",
	"before",
	"own",
	"through",
	"back",
	"should",
	"such",
	"over",
	"between",
	"again",
	"never",
	"always",
	"world",
	"come",
	"might",
	"even",
	"great",
	"want",
	"near",
	"right",
	"still",
	"good",
	"way",
	"use",
	"how",
	"time",
	"very",
	"only",
]);
/**
 * Damerau-Levenshtein distance (optimal string alignment variant).
 * Counts insertions, deletions, substitutions, and adjacent transpositions
 * as single edits. Case-insensitive.
 */
export function damerauLevenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	const prevPrev = new Array<number>(bLen + 1).fill(0);
	const prev = new Array<number>(bLen + 1).fill(0);
	const current = new Array<number>(bLen + 1).fill(0);

	for (let j = 0; j <= bLen; j++) prev[j] = j;

	for (let i = 1; i <= aLen; i++) {
		current[0] = i;
		for (let j = 1; j <= bLen; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				prev[j] + 1, // deletion
				current[j - 1] + 1, // insertion
				prev[j - 1] + cost, // substitution
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				current[j] = Math.min(current[j], prevPrev[j - 2] + 1); // transposition
			}
		}
		prevPrev.splice(0, bLen + 1, ...prev);
		prev.splice(0, bLen + 1, ...current);
	}
	return prev[bLen];
}

function rankSuggestions(target: string, words: ReadonlySet<string>): string[] {
	const lower = target.toLowerCase();
	const scored: Array<{ word: string; distance: number; frequent: boolean }> = [];
	for (const word of words) {
		if (Math.abs(word.length - lower.length) > MAX_EDIT_DISTANCE) continue;
		const distance = damerauLevenshtein(lower, word);
		if (distance <= MAX_EDIT_DISTANCE) {
			scored.push({ word, distance, frequent: FREQUENT_WORDS.has(word) });
		}
	}
	scored.sort((x, y) => {
		if (x.distance !== y.distance) return x.distance - y.distance;
		if (x.frequent !== y.frequent) return x.frequent ? -1 : 1;
		return x.word.localeCompare(y.word);
	});
	return scored.slice(0, MAX_SUGGESTIONS).map(entry => entry.word);
}
const TOKEN_SPLIT = /[^\p{L}\p{M}']+/u;

/** A self-contained, dependency-free dictionary backend. */
export class DictionarySpellingBackend implements SpellingBackend {
	#words: Set<string>;

	constructor(words: readonly string[] = DEFAULT_SPELLING_WORDLIST) {
		this.#words = new Set(words.map(word => word.toLowerCase()));
	}

	isAvailable(): boolean {
		return true;
	}

	checkSpelling(text: string): SpellingRange[] {
		const ranges: SpellingRange[] = [];
		const tokens = text.split(TOKEN_SPLIT);
		let cursor = 0;
		for (const token of tokens) {
			if (token.length === 0) {
				cursor++;
				continue;
			}
			const index = text.indexOf(token, cursor);
			if (index === -1) {
				cursor += token.length;
				continue;
			}
			if (token.length >= MIN_WORD_LENGTH && !this.#words.has(token.toLowerCase())) {
				ranges.push({ start: index, length: token.length });
			}
			cursor = index + token.length;
		}
		return ranges;
	}

	completeWord(text: string, start: number, length: number): string[] {
		const prefix = text.slice(start, start + length).toLowerCase();
		if (prefix.length < 2) return [];
		const matches: string[] = [];
		for (const word of this.#words) {
			if (word.startsWith(prefix) && word.length > prefix.length) {
				matches.push(word);
				if (matches.length >= MAX_SUGGESTIONS) break;
			}
		}
		// Prefer frequent words first.
		matches.sort((a, b) => {
			const af = FREQUENT_WORDS.has(a) ? 0 : 1;
			const bf = FREQUENT_WORDS.has(b) ? 0 : 1;
			return af - bf || a.localeCompare(b);
		});
		return matches;
	}

	autocorrectWord(text: string, start: number, length: number): string | null {
		const word = text.slice(start, start + length);
		if (this.#words.has(word.toLowerCase())) return null;
		const guesses = this.spellingGuesses(text, start, length);
		const best = guesses[0];
		if (!best) return null;
		// Only autocorrect with a confident (distance-1) match.
		return damaBest(word, guesses, this.#words);
	}

	spellingGuesses(text: string, start: number, length: number): string[] {
		const word = text.slice(start, start + length);
		return rankSuggestions(word, this.#words);
	}
	addWord(word: string): void {
		this.#words.add(word.toLowerCase());
	}
}

/** Return the single closest guess (distance 1 only), or null. */
function damaBest(word: string, guesses: readonly string[], _words: ReadonlySet<string>): string | null {
	const lower = word.toLowerCase();
	for (const guess of guesses) {
		if (damerauLevenshtein(lower, guess.toLowerCase()) === 1) {
			// Preserve the original casing when the guess differs only by case.
			if (word === word.toLowerCase() && guess === guess.toLowerCase()) return guess;
			return guess;
		}
	}
	return null;
}

export function isUnavailableBackend(): SpellingBackend {
	return {
		isAvailable: () => false,
		checkSpelling: () => [],
		completeWord: () => [],
		autocorrectWord: () => null,
		spellingGuesses: () => [],
	};
}
