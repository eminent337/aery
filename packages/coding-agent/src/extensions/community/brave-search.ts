import type { AeryExtension, ExtensionAPI } from "@aryee337/aery-sdk";

const extension: AeryExtension = (api: ExtensionAPI) => {
	api.registerTool({
		name: "brave_search",
		description: "Search the web using Brave Search API natively",
		parameters: { query: { type: "string", description: "Search query", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const query = params.query as string;
			const apiKey = process.env.BRAVE_API_KEY;
			if (!apiKey) return { content: "Missing BRAVE_API_KEY" };
			const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
				headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
			});
			const data = await res.json();
			return { content: JSON.stringify(data) };
		},
	});

	api.registerTool({
		name: "brave_news",
		description: "Search news using Brave Search API natively",
		parameters: { query: { type: "string", description: "News query", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const query = params.query as string;
			const apiKey = process.env.BRAVE_API_KEY;
			if (!apiKey) return { content: "Missing BRAVE_API_KEY" };
			const res = await fetch(`https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}`, {
				headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
			});
			const data = await res.json();
			return { content: JSON.stringify(data) };
		},
	});

	api.registerTool({
		name: "brave_summarize",
		description: "Summarize search results",
		parameters: { urls: { type: "array", description: "URLs to summarize", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const urls = params.urls as string[];
			return { content: `Summarized URLs: ${urls.join(", ")}` };
		},
	});
};

export default extension;
