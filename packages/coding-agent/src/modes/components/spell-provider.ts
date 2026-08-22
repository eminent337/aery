import type { EditorInlineReplacement, EditorTextAssistProvider, EditorWordReplacements } from "@aryee337/aery-tui";
import { maskNonProse } from "../markdown-prose";
import { DictionarySpellingBackend, isUnavailableBackend, type SpellingBackend } from "../spelling-backend";

const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;
const COMPLETED_WORD = /([\p{L}\p{M}']+)([\s.,;:!?"\])}])$/u;
const CODEISH_CHARACTERS = "\\/@_=:{}[]<>";
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
const CACHE_LIMIT = 256;
const MAX_SPELLING_LINE_LENGTH = 1_000;
const WORD_BOUNDARY = /[\s.,;:!?"\])}]/u;

/** Independently switchable prose-assistance features. */
export interface SpellingFeatures {
	typoDetection: boolean;
	autocomplete: boolean;
	autocorrect: boolean;
}

const DEFAULT_FEATURES: SpellingFeatures = {
	typoDetection: true,
	autocomplete: true,
	autocorrect: false,
};

/** Extract the whitespace-delimited token containing `start..end`. */
function tokenAt(text: string, start: number, end: number): string {
	let tokenStart = start;
	while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) tokenStart--;
	let tokenEnd = end;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
	return text.slice(tokenStart, tokenEnd);
}

/** Whether the span is genuinely prose the user addresses to the model. */
function isProseWord(text: string, masked: string, start: number, end: number): boolean {
	if (start < 0 || end <= start || end > text.length) return false;
	if (masked.slice(start, end).trim().length === 0) return false;
	const token = tokenAt(text, start, end);
	for (const char of token) {
		if (CODEISH_CHARACTERS.includes(char)) return false;
	}
	if (CAMEL_CASE.test(token) || /\d/.test(token)) return false;
	return !text.trimStart().startsWith("/") && !text.startsWith("->") && !text.startsWith("=>");
}

/**
 * Bridges Aery's pure-TS spelling backend into the editor's separate typo,
 * word-completion, and autocorrection paths. Mirrors omp's MacOSSpellingProvider
 * but replaces the macOS-only native backend with the bundled dictionary.
 */
export class SpellProvider implements EditorTextAssistProvider {
	#features: SpellingFeatures = { ...DEFAULT_FEATURES };
	#available: boolean;
	#typoCache = new Map<string, readonly { start: number; end: number }[]>();
	#decorateCache = new Map<string, string>();
	#lineResolver: (index: number) => string | undefined = () => undefined;

	constructor(private readonly backend: SpellingBackend = new DictionarySpellingBackend()) {
		this.#available = backend.isAvailable();
	}

	/** Apply the three independent feature gates and invalidate typo caches. */
	setFeatures(features: SpellingFeatures): void {
		if (
			this.#features.typoDetection === features.typoDetection &&
			this.#features.autocomplete === features.autocomplete &&
			this.#features.autocorrect === features.autocorrect
		) {
			return;
		}
		this.#features = { ...features };
		this.#available = this.backend.isAvailable();
		this.#typoCache.clear();
		this.#decorateCache.clear();
	}

	/** Resolver that returns the full source line by index so segments can be located. */
	setLineResolver(resolver: (index: number) => string | undefined): void {
		this.#lineResolver = resolver;
	}

	get available(): boolean {
		return this.#available;
	}

	get features(): SpellingFeatures {
		return { ...this.#features };
	}

	/**
	 * Decorate a rendered editor segment with red undercurls on misspellings,
	 * preserving visible text width. `lineIndex`/`colOffset` locate the segment
	 * inside the source line. `paint` styles each literal (non-typo) span and
	 * also the inner text of typo spans — analogous to omp's decorate callback,
	 * so magic-keyword highlighting can compose without disturbing offsets.
	 */
	decorateTypos(text: string, lineIndex: number, colOffset: number, paint?: (span: string) => string): string {
		if (!this.#available || !this.#features.typoDetection || text.length === 0) return text;
		const line = this.#lineResolver(lineIndex);
		if (line === undefined || line.length === 0 || line.length > MAX_SPELLING_LINE_LENGTH) return text;
		if (colOffset < 0 || colOffset + text.length > line.length) return text;
		const cacheKey = `${lineIndex}:${colOffset}:${text}`;
		const cached = this.#decorateCache.get(cacheKey);
		if (cached !== undefined) return cached;

		const startCol = colOffset;
		const endCol = colOffset + text.length;
		const masked = maskNonProse(line);
		const ranges = this.#typoRanges(line).filter(range => range.start >= startCol && range.end <= endCol);
		const style = paint ?? ((span: string) => span);
		let rendered = "";
		let cursor = 0;
		for (const range of ranges) {
			if (!isProseWord(line, masked, range.start, range.end)) continue;
			const localStart = range.start - startCol;
			const localEnd = range.end - startCol;
			rendered += style(text.slice(cursor, localStart));
			rendered += TYPO_UNDERLINE + style(text.slice(localStart, localEnd)) + TYPO_RESET;
			cursor = localEnd;
		}
		const result = rendered + style(text.slice(cursor));
		if (this.#decorateCache.size >= CACHE_LIMIT) this.#decorateCache.clear();
		this.#decorateCache.set(cacheKey, result);
		return result;
	}

	/** Return the completion suffix for the word ending at the cursor. */
	getWordCompletion(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (!this.#available || !this.#features.autocomplete) return null;
		const line = lines[cursorLine] ?? "";
		if (/^[\p{L}\p{M}']/u.test(line.slice(cursorCol))) return null;
		const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
		if (!match || match[0].length < 2) return null;
		const start = cursorCol - match[0].length;
		const masked = maskNonProse(line);
		if (!isProseWord(line, masked, start, cursorCol)) return null;
		const prefix = match[0];
		const lowerPrefix = prefix.toLocaleLowerCase();
		for (const completion of this.backend.completeWord(line, start, prefix.length)) {
			if (completion.length > prefix.length && completion.toLocaleLowerCase().startsWith(lowerPrefix)) {
				return completion.slice(prefix.length);
			}
		}
		return null;
	}

	/** Return the confident correction after a completed prose word. */
	tryAutocorrect(lines: string[], cursorLine: number, cursorCol: number): EditorInlineReplacement | null {
		if (!this.#available || !this.#features.autocorrect) return null;
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const match = COMPLETED_WORD.exec(textBeforeCursor);
		if (!match) return null;
		const word = match[1] ?? "";
		const boundary = match[2] ?? "";
		const start = match.index;
		const masked = maskNonProse(textBeforeCursor);
		if (!isProseWord(textBeforeCursor, masked, start, start + word.length)) return null;
		const correction = this.backend.autocorrectWord(textBeforeCursor, start, word.length);
		if (!correction || correction === word) return null;
		return { replaceLen: word.length + boundary.length, insert: correction + boundary };
	}

	/** Return replacement guesses for the misspelled word at the cursor. */
	getWordReplacements(lines: string[], cursorLine: number, cursorCol: number): EditorWordReplacements | null {
		if (!this.#available || !this.#features.typoDetection) return null;
		const line = lines[cursorLine] ?? "";
		if (line.length > MAX_SPELLING_LINE_LENGTH || cursorCol < 0 || cursorCol > line.length) return null;
		const masked = maskNonProse(line);
		const range = this.#typoRanges(line).find(candidate => {
			const end = candidate.end;
			return (
				cursorCol >= candidate.start &&
				(cursorCol <= end || (cursorCol === end + 1 && WORD_BOUNDARY.test(line[end] ?? ""))) &&
				isProseWord(line, masked, candidate.start, end)
			);
		});
		if (!range) return null;
		const seen = new Set<string>();
		const items: string[] = [];
		for (const guess of this.backend.spellingGuesses(line, range.start, range.end - range.start)) {
			if (!guess || seen.has(guess)) continue;
			seen.add(guess);
			items.push(guess);
			if (items.length === 10) break;
		}
		if (items.length === 0) return null;
		return { line: cursorLine, startCol: range.start, endCol: range.end, items };
	}

	#typoRanges(line: string): readonly { start: number; end: number }[] {
		const cached = this.#typoCache.get(line);
		if (cached) return cached;
		let ranges: { start: number; end: number }[] = [];
		try {
			const masked = maskNonProse(line);
			ranges = this.backend
				.checkSpelling(line)
				.map(range => ({ start: range.start, end: range.start + range.length }))
				.filter(range => isProseWord(line, masked, range.start, range.end))
				.toSorted((a, b) => a.start - b.start);
		} catch {
			this.#available = false;
		}
		if (this.#typoCache.size >= CACHE_LIMIT) this.#typoCache.clear();
		this.#typoCache.set(line, ranges);
		return ranges;
	}
}

const TYPO_UNDERLINE = "\u001b[4:3m\u001b[58:2::255:95:95m";
const TYPO_RESET = "\u001b[4:0m\u001b[59m";

export type { SpellingBackend };
export { DictionarySpellingBackend, isUnavailableBackend };
