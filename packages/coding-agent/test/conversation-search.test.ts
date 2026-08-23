import { describe, expect, it } from "bun:test";
import {
	bm25Score,
	extractMessageText,
	extractSnippet,
	searchMessages,
	tokenize,
} from "@aryee337/aery/tools/conversation-search";

const sampleMessages: { role: string; content: string }[] = [
	{ role: "user", content: "I want to build a web scraper in Python" },
	{ role: "assistant", content: "I'll help you build a Python web scraper using BeautifulSoup and requests library." },
	{ role: "user", content: "How do I handle pagination in my web scraper?" },
	{
		role: "assistant",
		content:
			"For pagination in a Python web scraper, you can use a while loop that checks for a next page link. Each iteration fetches the next page URL until no more pages remain.",
	},
	{ role: "user", content: "My Python script is running slowly. How can I optimize it?" },
	{
		role: "assistant",
		content:
			"To optimize a slow Python web scraper: use async requests with aiohttp, add connection pooling, implement caching, and avoid redundant parsing.",
	},
	{ role: "user", content: "What about error handling?" },
	{
		role: "assistant",
		content:
			"Add try/except blocks around your requests, implement retry logic with exponential backoff, and log failed URLs.",
	},
];

describe("conversation search", () => {
	it("tokenizes text into lowercase word tokens", () => {
		const tokens = tokenize("Hello World! How's it going?");
		expect(tokens).toEqual(["hello", "world", "how", "s", "it", "going"]);
	});

	it("returns empty tokens for empty input", () => {
		expect(tokenize("")).toEqual([]);
	});

	it("extractMessageText returns plain text from string content", () => {
		const msg = { role: "user", content: "hello world" };
		expect(extractMessageText(msg as never)).toBe("hello world");
	});

	it("extractMessageText joins text blocks from array content", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "first part" },
				{ type: "text", text: "second part" },
			],
		};
		expect(extractMessageText(msg as never)).toBe("first part\nsecond part");
	});

	it("extractMessageText skips non-text blocks", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "visible" },
				{ type: "image", data: "abc" },
			],
		};
		expect(extractMessageText(msg as never)).toBe("visible");
	});

	it("extractSnippet returns text around the first query term match", () => {
		const text = "The quick brown fox jumps over the lazy dog near the river";
		const snippet = extractSnippet(text, ["fox"], 10);
		expect(snippet).toContain("fox");
		expect(snippet).toContain("brown fox");
		expect(snippet).toContain("jumps");
	});

	it("extractSnippet adds ellipsis when text extends beyond window", () => {
		const text = "a".repeat(200);
		const snippet = extractSnippet(text, ["a"], 10);
		expect(snippet.endsWith("...")).toBe(true);
	});

	it("bm25Score returns 0 when query terms are absent", () => {
		const docTf = new Map([["hello", 1]]);
		const idfCache = new Map([["world", 1]]);
		const score = bm25Score(["world"], docTf, 5, 5, idfCache);
		expect(score).toBe(0);
	});

	it("bm25Score returns positive when query terms are present", () => {
		const docTf = new Map([["hello", 2]]);
		const idfCache = new Map([["hello", 1.5]]);
		const score = bm25Score(["hello"], docTf, 5, 5, idfCache);
		expect(score).toBeGreaterThan(0);
	});

	it("searchMessages finds relevant messages ranked by BM25 score", () => {
		const results = searchMessages(sampleMessages as never, "python web scraper", 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results.length).toBeLessThanOrEqual(5);
		// First result should mention python and scraper
		const topSnippet = results[0]?.snippet.toLowerCase() ?? "";
		const hasRelevantTerm = topSnippet.includes("python") || topSnippet.includes("scraper");
		expect(hasRelevantTerm).toBe(true);
	});

	it("searchMessages ranks more relevant messages higher", () => {
		const results = searchMessages(sampleMessages as never, "optimize python performance", 3);
		expect(results.length).toBeGreaterThan(0);
		// Scores should be in descending order
		for (let i = 1; i < results.length; i++) {
			expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
		}
	});

	it("searchMessages returns empty for empty query", () => {
		expect(searchMessages(sampleMessages as never, "", 10)).toEqual([]);
	});

	it("searchMessages returns empty for empty messages", () => {
		expect(searchMessages([], "test", 10)).toEqual([]);
	});

	it("searchMessages respects maxResults", () => {
		const results = searchMessages(sampleMessages as never, "python", 2);
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it("searchMessages includes turn index and role", () => {
		const results = searchMessages(sampleMessages as never, "pagination", 5);
		expect(results.length).toBeGreaterThan(0);
		const top = results[0]!;
		expect(top.turn).toBeGreaterThanOrEqual(0);
		expect(top.role).toBeDefined();
		expect(typeof top.snippet).toBe("string");
		expect(top.snippet.length).toBeGreaterThan(0);
	});
});
