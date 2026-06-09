/**
 * DuckDuckGo Web Search Provider (no-auth fallback)
 *
 * Uses `duck-duck-scrape` package as primary, falls back to HTML scraping.
 * No API key required — safety net when all other providers fail.
 */
import type { SearchResponse } from "../types";
import { SearchProviderError } from "../types";
import { type SearchParams, SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

interface DDGSearchResult {
	hostname: string;
	url: string;
	title: string;
	description: string;
	rawDescription: string;
	icon: string;
}

interface DDGSearchResults {
	noResults: boolean;
	vqd: string;
	results: DDGSearchResult[];
}

async function scrapeViaPackage(query: string, limit: number, signal?: AbortSignal): Promise<DDGSearchResult[]> {
	try {
		const mod = await import("duck-duck-scrape");
		const { search } = mod.default ?? mod;
		const results = await search(query, { safeSearch: "moderate" as any }, { signal });
		return results.results.slice(0, limit);
	} catch {
		return [];
	}
}

async function scrapeViaHTML(query: string, limit: number, signal?: AbortSignal): Promise<DDGSearchResult[]> {
	try {
		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		const response = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; Aery/1.0)",
				Accept: "text/html",
			},
			signal: withHardTimeout(signal),
		});

		if (!response.ok) return [];

		const html = await response.text();

		// Bot detection: DuckDuckGo serves challenge pages with anomaly-modal class
		if (html.includes('class="anomaly-modal') || html.includes("anomaly-modal__box")) {
			throw new SearchProviderError("ddg", "DuckDuckGo blocked the request (bot detection)", 403);
		}

		const results: DDGSearchResult[] = [];

		// Combined regex capturing URL, title, and snippet in one pass
		const rx =
			/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

		let m;
		while ((m = rx.exec(html)) !== null && results.length < limit) {
			// Extract and decode the uddg redirect parameter
			const rawUrl = m[1]
				.split("&rut=")[0]
				.split("&amp;rut=")[0]
				.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "");
			const decodedUrl = decodeURIComponent(rawUrl);

			const title = m[2].replace(/<[^>]+>/g, "").trim();
			const snippet = m[3].replace(/<[^>]+>/g, "").trim();

			// Only accept valid HTTP URLs
			if (title && decodedUrl.startsWith("http")) {
				results.push({
					hostname: "",
					url: decodedUrl,
					title,
					description: snippet,
					rawDescription: snippet,
					icon: "",
				});
			}
		}

		return results;
	} catch {
		return [];
	}
}

export async function searchDDG(params: SearchParams): Promise<SearchResponse> {
	const limit = params.numSearchResults ?? params.limit ?? 10;
	const signal = withHardTimeout(params.signal);

	let results = await scrapeViaPackage(params.query, limit, signal);

	if (results.length === 0) {
		results = await scrapeViaHTML(params.query, limit, signal);
	}

	if (results.length === 0) {
		throw new SearchProviderError("ddg", "DuckDuckGo returned no results", 204);
	}

	const sources = results.map(r => ({
		title: r.title,
		url: r.url,
		snippet: r.description,
		publishedDate: undefined,
		ageSeconds: undefined,
		author: undefined,
	}));

	return {
		provider: "ddg",
		answer: undefined,
		sources: sources.slice(0, limit),
	};
}

export class DDGProvider extends SearchProvider {
	readonly id = "ddg" as const;
	readonly label = "DuckDuckGo";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDDG(params);
	}
}
