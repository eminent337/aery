/**
 * Search context tool — expose the session's search context for reading/writing.
 *
 * Ported from jcode upstream (crates/jcode-app-core/src/tool/agentgrep.rs
 * AgentGrepHarnessContext). The search context remembers what parts of the
 * codebase have been searched, with confidence scores. This tool lets the
 * model read coverage, record new searches, and manage focus files.
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { SearchContext } from "../search/context";
import type { ToolSession } from "./index";

const searchContextSchema = z.object({
	action: z
		.enum(["status", "record_file", "record_region", "record_symbol", "add_focus", "prune", "clear"])
		.describe("Action to perform"),
	path: z.string().optional().describe("File path for record/add_focus"),
	startLine: z.number().int().optional().describe("Start line for record_region"),
	endLine: z.number().int().optional().describe("End line for record_region"),
	symbol: z.string().optional().describe("Symbol name for record_symbol"),
	kind: z.string().optional().describe("Symbol kind (function, class, etc.)"),
});

export type SearchContextParams = z.infer<typeof searchContextSchema>;

const kSearchContext = Symbol("search.context");

interface AgentSessionWithSearchContext {
	[kSearchContext]?: SearchContext;
}

function getSearchContext(session: ToolSession): SearchContext {
	const s = session as unknown as AgentSessionWithSearchContext;
	if (!s[kSearchContext]) {
		s[kSearchContext] = new SearchContext();
	}
	return s[kSearchContext];
}

export class SearchContextTool implements AgentTool<typeof searchContextSchema> {
	readonly name = "search_context";
	readonly approval = "read" as const;
	readonly label = "Search Context";
	readonly description =
		"Manage the session's search context — track searched files/regions/symbols with confidence scores. Use to coordinate search coverage across calls: read status to find unexplored areas, record_file/region/symbol to mark coverage, add_focus to prioritize, prune to clean stale entries.";
	readonly loadMode = "discoverable";
	readonly summary = "Read/write search context with confidence scores";
	readonly parameters = searchContextSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SearchContextTool | null {
		return new SearchContextTool(session);
	}

	async execute(_id: string, params: SearchContextParams): Promise<AgentToolResult> {
		const ctx = getSearchContext(this.session);

		switch (params.action) {
			case "status": {
				const lines = [
					`## Search Context\n\n- Files tracked: ${ctx.knownFiles.length}\n- Regions tracked: ${ctx.knownRegions.length}\n- Symbols tracked: ${ctx.knownSymbols.length}\n- Focus files: ${ctx.focusFiles.length}`,
				];
				if (ctx.focusFiles.length > 0) {
					lines.push("", "### Focus Files");
					for (const f of ctx.focusFiles) lines.push(`- ${f}`);
				}
				if (ctx.knownFiles.length > 0) {
					lines.push("", "### Known Files");
					for (const f of ctx.knownFiles) {
						lines.push(`- ${f.path} (body: ${f.confidence.body.toFixed(2)})`);
					}
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						files: ctx.knownFiles.length,
						regions: ctx.knownRegions.length,
						symbols: ctx.knownSymbols.length,
						focusFiles: ctx.focusFiles.length,
					},
				};
			}
			case "record_file": {
				if (!params.path) throw new Error("record_file requires a path");
				ctx.recordFile({ path: params.path });
				return {
					content: [
						{ type: "text", text: `Recorded file ${params.path} (${ctx.knownFiles.length} files tracked).` },
					],
					details: { path: params.path, totalFiles: ctx.knownFiles.length },
				};
			}
			case "record_region": {
				if (!params.path || params.startLine === undefined || params.endLine === undefined) {
					throw new Error("record_region requires path, startLine, endLine");
				}
				ctx.recordRegion({ path: params.path, startLine: params.startLine, endLine: params.endLine });
				return {
					content: [
						{ type: "text", text: `Recorded region ${params.path}:${params.startLine}-${params.endLine}.` },
					],
					details: { path: params.path, startLine: params.startLine, endLine: params.endLine },
				};
			}
			case "record_symbol": {
				if (!params.path || !params.symbol) throw new Error("record_symbol requires path and symbol");
				ctx.recordSymbol({ path: params.path, symbol: params.symbol, kind: params.kind });
				return {
					content: [{ type: "text", text: `Recorded symbol ${params.symbol} in ${params.path}.` }],
					details: { path: params.path, symbol: params.symbol },
				};
			}
			case "add_focus": {
				if (!params.path) throw new Error("add_focus requires a path");
				ctx.addFocusFile(params.path);
				return {
					content: [{ type: "text", text: `Added focus file ${params.path}.` }],
					details: { path: params.path, focusFiles: ctx.focusFiles.length },
				};
			}
			case "prune": {
				const pruned = ctx.prune();
				return {
					content: [{ type: "text", text: `Pruned ${pruned} stale entries.` }],
					details: { pruned },
				};
			}
			case "clear": {
				ctx.clear();
				return {
					content: [{ type: "text", text: "Cleared search context." }],
					details: { cleared: true },
				};
			}
		}
	}
}
