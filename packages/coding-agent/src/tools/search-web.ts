/**
 * SearchWebTool — Ported from Google Antigravity (agy).
 *
 * Direct agy-compatible web search tool named `search_web`:
 * - query: search query string
 * - domain: optional domain to prioritize (e.g. "github.com")
 *
 * Delegates to Aery's underlying WebSearchTool while preserving exact agy tool semantics.
 */

import * as z from "zod/v4";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import { WebSearchTool, webSearchSchema } from "../web/search";
import type { ToolSession } from "./index";

const searchWebSchema = webSearchSchema.extend({
	domain: z.string().optional().describe("Optional domain to recommend the search prioritize (agy format)."),
});

export type SearchWebParams = z.infer<typeof searchWebSchema>;

export class SearchWebTool implements AgentTool<typeof searchWebSchema> {
	readonly name = "search_web";
	readonly approval = "read" as const;
	readonly label = "Search Web";
	readonly description =
		"Performs a web search for a given query. Returns a summary of relevant information along with URL citations.";
	readonly parameters = searchWebSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Web search tool matching agy search_web schema";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SearchWebTool {
		return new SearchWebTool(session);
	}

	async execute(
		toolCallId: string,
		params: SearchWebParams,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const webSearch = new WebSearchTool(this.session);
		let query = params.query;
		if (params.domain) {
			query = `site:${params.domain} ${query}`;
		}
		return (webSearch as any).execute(toolCallId, { ...params, query }, signal, onUpdate, context);
	}
}
