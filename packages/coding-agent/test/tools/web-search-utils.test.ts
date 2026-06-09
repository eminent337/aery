import { describe, expect, it } from "bun:test";
import { extractMcpSources } from "../../src/web/search/providers/utils";

describe("extractMcpSources", () => {
	describe("JSON search results parsing", () => {
		it("parses JSON search results with results array", () => {
			const text = JSON.stringify({
				results: [{ url: "https://example.com", title: "Example", excerpt: "An example page" }],
			});

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(1);
			expect(sources[0]).toMatchObject({
				title: "Example",
				url: "https://example.com",
				snippet: "An example page",
			});
		});

		it("handles publish_date field mapping to publishedDate", () => {
			const text = JSON.stringify({
				results: [
					{ url: "https://news.com", title: "News Article", excerpt: "Breaking news", publish_date: "2024-06-01" },
				],
			});

			const sources = extractMcpSources(text);

			expect(sources[0].publishedDate).toBe("2024-06-01");
		});

		it("skips entries without url", () => {
			const text = JSON.stringify({
				results: [
					{ title: "No URL", excerpt: "skip me" },
					{ url: "https://valid.com", title: "Valid", excerpt: "include me" },
				],
			});

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(1);
			expect(sources[0].url).toBe("https://valid.com");
		});

		it("uses url as title fallback when title is missing", () => {
			const text = JSON.stringify({
				results: [{ url: "https://untitled.com", excerpt: "no title field" }],
			});

			const sources = extractMcpSources(text);

			expect(sources[0].title).toBe("https://untitled.com");
		});
	});

	describe("Title:/URL: block parsing (Exa format)", () => {
		it("extracts Title:\\nURL: blocks", () => {
			const text = `Title: Aether
URL: https://aether.io/
Published: N/A

Title: Aeria
URL: https://aeria.cx/docs`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(2);
			expect(sources[0]).toMatchObject({
				title: "Aether",
				url: "https://aether.io/",
			});
			expect(sources[1]).toMatchObject({
				title: "Aeria",
				url: "https://aeria.cx/docs",
			});
		});

		it("uses URL as title fallback when Title line is absent", () => {
			const text = `Some text
URL: https://bareurl.com
More text`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(1);
			expect(sources[0].title).toBe("https://bareurl.com");
			expect(sources[0].url).toBe("https://bareurl.com");
		});

		it("handles URL: without preceding Title: on its own line", () => {
			const text = `URL: https://orphan.com\nTitle: Orphan`;

			const sources = extractMcpSources(text);

			// extractUrlLabelBlocks looks for last Title: before URL line
			// so orphan title may not associate correctly — that's ok, just check URL is found
			expect(sources.some(s => s.url === "https://orphan.com")).toBe(true);
		});
	});

	describe("markdown link parsing", () => {
		it("extracts markdown links", () => {
			const text = `Check out [the docs](https://docs.example.com) for more.`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(1);
			expect(sources[0]).toMatchObject({
				title: "the docs",
				url: "https://docs.example.com",
			});
		});

		it("extracts multiple markdown links", () => {
			const text = `[Alpha](https://a.com) and [Beta](https://b.com) and [Gamma](https://c.com)`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(3);
			expect(sources.map(s => s.url)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
		});

		it("uses URL as title fallback when link text is empty", () => {
			const text = `[](https://empty-text.com)`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(1);
			expect(sources[0].title).toBe("https://empty-text.com");
		});

		it("matches image links (current regex matches ![text](url) same as [text](url))", () => {
			const text = `![logo](https://img.com/logo.png) and regular text`;

			const sources = extractMcpSources(text);

			// Current regex is structural, not semantic — ![text](url) matches same as [text](url)
			expect(sources.some(s => s.url === "https://img.com/logo.png")).toBe(true);
		});
	});

	describe("bare URL parsing", () => {
		it("extracts bare URLs at line start", () => {
			const text = `Visit
https://example.com for more information.`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(1);
			expect(sources[0]).toMatchObject({
				url: "https://example.com",
			});
		});

		it("extracts bare URLs after newlines", () => {
			const text = `Line one

https://newline.com

Line three`;

			const sources = extractMcpSources(text);

			expect(sources.some(s => s.url === "https://newline.com")).toBe(true);
		});
	});

	describe("mixed content handling", () => {
		it("prioritizes JSON results when text is valid parseable JSON", () => {
			const text = JSON.stringify({
				results: [{ url: "https://json-result.com", title: "JSON Result", excerpt: "from JSON" }],
			});

			const sources = extractMcpSources(text);

			expect(sources[0].url).toBe("https://json-result.com");
		});

		it("falls back to markdown when text is not valid JSON", () => {
			const text = `[Markdown Link](https://markdown.com)`;

			const sources = extractMcpSources(text);

			expect(sources[0].url).toBe("https://markdown.com");
		});

		it("returns Title:/URL: sources when JSON parsing yields nothing", () => {
			// JSON with no results array
			const text = `{"search_id": "s1"}\n\nTitle: Block Result\nURL: https://block.com`;

			const sources = extractMcpSources(text);

			expect(sources.some(s => s.url === "https://block.com")).toBe(true);
		});
	});

	describe("deduplication", () => {
		it("deduplicates sources by URL", () => {
			const text = `[Link A](https://dup.com) and [Link A again](https://dup.com) and also https://dup.com`;

			const sources = extractMcpSources(text);

			const dupUrls = sources.filter(s => s.url === "https://dup.com");
			expect(dupUrls).toHaveLength(1);
		});

		it("deduplicates across different extraction methods", () => {
			const text = `${JSON.stringify({
				results: [{ url: "https://shared.com", title: "JSON", excerpt: "from JSON" }],
			})}\n\n[Markdown](https://shared.com)`;

			const sources = extractMcpSources(text);

			const sharedUrls = sources.filter(s => s.url === "https://shared.com");
			expect(sharedUrls).toHaveLength(1);
		});
	});

	describe("edge cases", () => {
		it("returns empty array when nothing matches", () => {
			const text = `No URLs here. No JSON. No markdown. Nothing parseable.`;

			const sources = extractMcpSources(text);

			expect(sources).toHaveLength(0);
		});

		it("handles empty string", () => {
			const sources = extractMcpSources("");
			expect(sources).toHaveLength(0);
		});

		it("handles whitespace-only text", () => {
			const sources = extractMcpSources("   \n\n  \n");
			expect(sources).toHaveLength(0);
		});

		it("returns SearchSource[] with correct shape", () => {
			const text = JSON.stringify({
				results: [{ url: "https://shape.com", title: "Shape Test", excerpt: "snippet" }],
			});

			const sources = extractMcpSources(text);

			expect(sources[0]).toHaveProperty("title");
			expect(sources[0]).toHaveProperty("url");
			expect(typeof sources[0].url).toBe("string");
			expect(sources[0].url).toContain("https://");
		});

		it("handles malformed JSON gracefully", () => {
			const text = `{not valid json {`;

			const sources = extractMcpSources(text);

			// Should fall through to other extraction methods; if none match, empty
			expect(Array.isArray(sources)).toBe(true);
		});
	});
});
