import type { ExtensionAPI } from "@aryee337/aery";

export default function registerBraveSearch(aery: ExtensionAPI) {
	aery.registerTool({
		name: "brave_search",
		label: "Brave Search",
		description: "Search the web using Brave Search API.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The search query." },
			},
			required: ["query"],
		},
		async execute(_id: string, args: Record<string, any>) {
			const query = args.query as string;
			const apiKey = process.env.BRAVE_API_KEY || "dummy_key";
			const endpoint = "https://api.search.brave.com/res/v1/web/search";

			try {
				const url = new URL(endpoint);
				url.searchParams.append("q", query);

				const response = await fetch(url.toString(), {
					headers: {
						Accept: "application/json",
						"Accept-Encoding": "gzip",
						"X-Subscription-Token": apiKey,
					},
				});

				if (!response.ok) {
					throw new Error(`Brave API error: ${response.statusText}`);
				}

				const data = (await response.json()) as any;

				if (!data.web?.results || data.web.results.length === 0) {
					return { content: [{ type: "text", text: "No results found." }] };
				}

				let resultText = `Search results for "${query}":\n\n`;
				for (const result of data.web.results) {
					resultText += `- ${result.title}\n`;
					resultText += `  URL: ${result.url}\n`;
					if (result.description) {
						resultText += `  Description: ${result.description}\n`;
					}
					resultText += "\n";
				}

				return { content: [{ type: "text", text: resultText.trim() }] };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error performing Brave search: ${err.message}` }] };
			}
		},
	});
}
