import { describe, expect, it, mock } from "bun:test";
import { type SpellingFeatures, SpellProvider } from "../../src/modes/components/spell-provider";
import type { SpellingBackend } from "../../src/modes/spelling-backend";

const TYPO_UNDERLINE = "\u001b[4:3m\u001b[58:2::255:95:95m";
const TYPO_RESET = "\u001b[4:0m\u001b[59m";

function backend(overrides: Partial<SpellingBackend>): SpellingBackend {
	return {
		isAvailable: () => true,
		checkSpelling: () => [],
		completeWord: () => [],
		autocorrectWord: () => null,
		spellingGuesses: () => [],
		...overrides,
	};
}

function features(overrides: Partial<SpellingFeatures> = {}): SpellingFeatures {
	return { typoDetection: true, autocomplete: true, autocorrect: false, ...overrides };
}

function makeProvider(backendImpl: SpellingBackend, featuresImpl: SpellingFeatures, lines: string[]): SpellProvider {
	const provider = new SpellProvider(backendImpl);
	provider.setFeatures(featuresImpl);
	provider.setLineResolver(index => lines[index]);
	return provider;
}

describe("SpellProvider feature gates", () => {
	it("enables typo detection without enabling autocomplete or autocorrect", () => {
		const completeWord = mock(() => ["received"]);
		const autocorrectWord = mock(() => "received");
		const spellingGuesses = mock(() => ["received", "relieved"]);
		const provider = makeProvider(
			backend({
				checkSpelling: () => [{ start: 0, length: 8 }],
				completeWord,
				autocorrectWord,
				spellingGuesses,
			}),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["recieved"],
		);

		expect(provider.decorateTypos("recieved", 0, 0)).toBe(`${TYPO_UNDERLINE}recieved${TYPO_RESET}`);
		expect(provider.getWordCompletion(["recieved"], 0, 8)).toBeNull();
		expect(provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(provider.getWordReplacements(["recieved "], 0, 9)).toEqual({
			line: 0,
			startCol: 0,
			endCol: 8,
			items: ["received", "relieved"],
		});
		expect(completeWord).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
	});

	it("enables word autocomplete without enabling typo detection or autocorrect", () => {
		const checkSpelling = mock(() => [{ start: 4, length: 5 }]);
		const autocorrectWord = mock(() => "weather");
		const spellingGuesses = mock(() => ["weather"]);
		const provider = makeProvider(
			backend({ checkSpelling, completeWord: () => ["weather"], autocorrectWord, spellingGuesses }),
			features({ typoDetection: false, autocomplete: true, autocorrect: false }),
			["The weath"],
		);

		expect(provider.decorateTypos("The weath", 0, 0)).toBe("The weath");
		expect(provider.getWordCompletion(["The weath"], 0, 9)).toBe("er");
		expect(provider.tryAutocorrect(["weath "], 0, 6)).toBeNull();
		expect(provider.getWordReplacements(["The weath"], 0, 6)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});

	it("enables autocorrect without enabling typo detection or autocomplete", () => {
		const checkSpelling = mock(() => [{ start: 0, length: 4 }]);
		const completeWord = mock(() => ["weath"]);
		const spellingGuesses = mock(() => ["weath"]);
		const provider = makeProvider(
			backend({ checkSpelling, completeWord, autocorrectWord: () => "weather", spellingGuesses }),
			features({ typoDetection: false, autocomplete: false, autocorrect: true }),
			["weath "],
		);

		expect(provider.decorateTypos("weath ", 0, 0)).toBe("weath ");
		expect(provider.getWordCompletion(["weath "], 0, 3)).toBeNull();
		expect(provider.tryAutocorrect(["weath "], 0, 6)).toEqual({
			replaceLen: 6,
			insert: "weather ",
		});
		expect(provider.getWordReplacements(["weath "], 0, 6)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(completeWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});
});

describe("SpellProvider prose masking", () => {
	it("does not decorate typos inside inline code spans", () => {
		const provider = makeProvider(
			backend({ checkSpelling: () => [{ start: 6, length: 8 }] }),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["use `recieved` here"],
		);
		expect(provider.decorateTypos("use ", 0, 0)).toBe("use ");
		expect(provider.decorateTypos("`recieved`", 0, 4)).toBe("`recieved`");
		expect(provider.decorateTypos(" here", 0, 13)).toBe(" here");
	});

	it("masks typos inside unclosed fences as code", () => {
		const provider = makeProvider(
			backend({ checkSpelling: () => [{ start: 4, length: 8 }] }),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["```", "recieved", "```"],
		);
		expect(provider.decorateTypos("recieved", 1, 0)).toBe("recieved");
	});

	it("skips command-style lines and tokens with digits", () => {
		const provider = makeProvider(
			backend({
				checkSpelling: text => {
					const ranges: { start: number; length: number }[] = [];
					let offset = 0;
					for (const word of text.split(/\s+/)) {
						if (word !== "and") ranges.push({ start: offset, length: word.length });
						offset += word.length + 1;
					}
					return ranges;
				},
			}),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["/recieved and ver2"],
		);
		// Command-style leading slash suppresses decoration on the whole line.
		expect(provider.decorateTypos("/recieved", 0, 0)).toBe("/recieved");
		expect(provider.decorateTypos(" and", 0, 9)).toBe(" and");
		expect(provider.decorateTypos(" ver2", 0, 13)).toBe(" ver2");
	});
});

describe("SpellProvider segments", () => {
	it("decorates typos only within the given segment bounds", () => {
		const provider = makeProvider(
			backend({ checkSpelling: () => [{ start: 6, length: 8 }] }),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["hello recieved world"],
		);
		// Segment that does not cover the typo -> untouched.
		expect(provider.decorateTypos("hello ", 0, 0)).toBe("hello ");
		// Segment exactly covering the typo span.
		expect(provider.decorateTypos("recieved", 0, 6)).toBe(`${TYPO_UNDERLINE}recieved${TYPO_RESET}`);
		// Segment after the typo -> untouched.
		expect(provider.decorateTypos(" world", 0, 14)).toBe(" world");
	});

	it("handles multi-segment render of one line", () => {
		const provider = makeProvider(
			backend({ checkSpelling: () => [{ start: 4, length: 4 }] }),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["one twpo three four"],
		);
		expect(provider.decorateTypos("one ", 0, 0)).toBe("one ");
		expect(provider.decorateTypos("twpo", 0, 4)).toBe(`${TYPO_UNDERLINE}twpo${TYPO_RESET}`);
		expect(provider.decorateTypos(" three four", 0, 8)).toBe(" three four");
	});
});

describe("SpellProvider replacements", () => {
	it("returns suggestions when the cursor is at/just past the typo boundary", () => {
		const provider = makeProvider(
			backend({
				checkSpelling: () => [{ start: 4, length: 5 }],
				spellingGuesses: () => ["quick"],
			}),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["the qucik brown fox"],
		);
		// Cursor inside the typo.
		expect(provider.getWordReplacements(["the qucik brown fox"], 0, 5)).toEqual({
			line: 0,
			startCol: 4,
			endCol: 9,
			items: ["quick"],
		});
		// Cursor just past the typo + boundary space still counts.
		expect(provider.getWordReplacements(["the qucik brown fox"], 0, 10)).toEqual({
			line: 0,
			startCol: 4,
			endCol: 9,
			items: ["quick"],
		});
		// Cursor on a later word is out of range.
		expect(provider.getWordReplacements(["the qucik brown fox"], 0, 12)).toBeNull();
	});

	it("returns null when there are no dict guesses", () => {
		const provider = makeProvider(
			backend({
				checkSpelling: () => [{ start: 0, length: 6 }],
				spellingGuesses: () => [],
			}),
			features({ typoDetection: true, autocomplete: false, autocorrect: false }),
			["zzzxxx qqq"],
		);
		expect(provider.getWordReplacements(["zzzxxx qqq"], 0, 3)).toBeNull();
	});
});
