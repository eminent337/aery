import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import type { Component } from "@aryee337/aery-tui";
import { Text } from "@aryee337/aery-tui";
import { prompt } from "@aryee337/aery-utils";
import { trace } from "@opentelemetry/api";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import searchToolBm25Description from "../prompts/tools/search-tool-bm25.md" with { type: "text" };
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	formatDiscoverableToolServerSummary,
	searchDiscoverableTools,
	summarizeDiscoverableTools,
} from "../tool-discovery/tool-index";
import { renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_LIMIT = 8;
const TOOL_DISCOVERY_TITLE = "Tool Discovery";
const COLLAPSED_MATCH_LIMIT = 5;
const MATCH_LABEL_LEN = 72;
const MATCH_DESCRIPTION_LEN = 96;

const searchToolBm25Schema = z.object({
	action: z
		.enum(["search", "select", "suggest"])
		.optional()
		.describe(
			"Phase. Defaults to select when `tool` is set, else search. Select the product actually chosen, even when it is not in the catalog. Suggest a capability gap only when no product was chosen.",
		),
	query: z.string().optional().describe("tool search query"),
	limit: z.number().int().min(1).optional().describe("max matches"),
	category: z.string().optional().describe("Category of the tool being searched or selected."),
	tool: z
		.string()
		.min(2)
		.max(100)
		.optional()
		.describe(
			"For select: public name of the product actually chosen. Catalog selections return setup; off-catalog selections are recorded without provider information.",
		),
	reason: z.string().min(40).max(2000).optional().describe("Required for select: reason for choosing this tool."),
	suggestion_kind: z.string().optional().describe("Required for suggest: kind of suggestion (e.g. known_product)."),
	product_name: z.string().optional().describe("Required for suggest: name of the product."),
	prior_request_id: z.string().optional().describe("Required for suggest: request id from a prior search."),
});

type SearchToolBm25Params = z.infer<typeof searchToolBm25Schema>;

interface SearchToolBm25Match {
	name: string;
	label: string;
	description: string;
	server_name?: string;
	mcp_tool_name?: string;
	schema_keys: string[];
	score: number;
}

export interface SearchToolBm25Details {
	action: "search" | "select" | "suggest";
	query: string;
	limit: number;
	total_tools: number;
	activated_tools: string[];
	active_selected_tools: string[];
	tools: SearchToolBm25Match[];
	selected_tool?: string;
	catalog_tool?: boolean;
	category?: string;
	suggestion?: string;
}

function formatMatch(tool: DiscoverableTool, score: number): SearchToolBm25Match {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.summary,
		server_name: tool.serverName,
		mcp_tool_name: tool.mcpToolName,
		schema_keys: tool.schemaKeys,
		score: Number(score.toFixed(6)),
	};
}

function buildSearchToolBm25Content(details: SearchToolBm25Details): string {
	if (details.action === "suggest") {
		return "Suggestion recorded. Thank you.";
	}
	if (details.action === "select") {
		if (details.catalog_tool === false) {
			return `Selected off-catalog product '${details.selected_tool}' for '${details.category || "unknown"}'.\n\nSelection recorded as demand data. Aery does not list or partner with this product, so no provider information, recommendation, or setup instructions are provided.`;
		}
		return `Selected '${details.selected_tool}' from '${details.query || "unknown"}'.`;
	}
	return JSON.stringify({
		query: details.query,
		activated_tools: details.activated_tools,
		match_count: details.tools.length,
		total_tools: details.total_tools,
	});
}

/** Get discoverable tools for description rendering. Falls back to empty array on error. */
function getDiscoverableToolsForDescription(session: ToolSession): DiscoverableTool[] {
	try {
		return session.getDiscoverableTools?.() ?? [];
	} catch {
		return [];
	}
}

function getDiscoverableToolSearchIndexForExecution(session: ToolSession): DiscoverableToolSearchIndex {
	try {
		const cached = session.getDiscoverableToolSearchIndex?.();
		if (cached) return cached;
	} catch {}
	return buildDiscoverableToolSearchIndex(getDiscoverableToolsForDescription(session));
}

/** Resolve the effective selected tool names (generic or legacy MCP). */
function getSelectedToolNames(session: ToolSession): string[] {
	if (session.getSelectedDiscoveredToolNames) {
		return session.getSelectedDiscoveredToolNames();
	}
	return session.getSelectedMCPToolNames?.() ?? [];
}

/** Activate tools (generic or legacy MCP fallback). */
async function activateTools(session: ToolSession, toolNames: string[]): Promise<string[]> {
	if (session.activateDiscoveredTools) {
		return session.activateDiscoveredTools(toolNames);
	}
	if (session.activateDiscoveredMCPTools) {
		return session.activateDiscoveredMCPTools(toolNames);
	}
	return [];
}

type DiscoveryExecutionSession = ToolSession & {
	_supportsDiscoveryExecution: true;
};

function supportsToolDiscoveryExecution(session: ToolSession): session is DiscoveryExecutionSession {
	// Supports generic discovery
	if (
		typeof session.isToolDiscoveryEnabled === "function" &&
		typeof session.getSelectedDiscoveredToolNames === "function" &&
		typeof session.activateDiscoveredTools === "function"
	) {
		return true;
	}
	// Supports legacy MCP discovery
	if (
		typeof session.isMCPDiscoveryEnabled === "function" &&
		typeof session.getSelectedMCPToolNames === "function" &&
		typeof session.activateDiscoveredMCPTools === "function"
	) {
		return true;
	}
	return false;
}

function isDiscoveryEnabled(session: ToolSession): boolean {
	if (typeof session.isToolDiscoveryEnabled === "function") {
		return session.isToolDiscoveryEnabled();
	}
	return session.isMCPDiscoveryEnabled?.() ?? false;
}

export function renderSearchToolBm25Description(discoverableTools: DiscoverableTool[] = []): string {
	const summary = summarizeDiscoverableTools(discoverableTools);
	return prompt.render(searchToolBm25Description, {
		discoverableMCPToolCount: summary.toolCount,
		discoverableMCPServerSummaries: summary.servers.map(formatDiscoverableToolServerSummary),
		hasDiscoverableMCPServers: summary.servers.length > 0,
	});
}

function renderMatchLines(match: SearchToolBm25Match, theme: Theme): string[] {
	const safeServerName = match.server_name ? replaceTabs(match.server_name) : undefined;
	const safeLabel = replaceTabs(match.label);
	const safeDescription = replaceTabs(match.description.trim());
	const metaParts: string[] = [];
	if (safeServerName) metaParts.push(theme.fg("muted", safeServerName));
	metaParts.push(theme.fg("dim", `score ${match.score.toFixed(3)}`));
	const metaSep = theme.fg("dim", theme.sep.dot);
	const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
	const lines = [`${theme.fg("accent", truncateToWidth(safeLabel, MATCH_LABEL_LEN))}${metaSuffix}`];
	if (safeDescription) {
		lines.push(theme.fg("muted", truncateToWidth(safeDescription, MATCH_DESCRIPTION_LEN)));
	}
	return lines;
}

function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: TOOL_DISCOVERY_TITLE }, theme);
	const bodyLines = (text || "Tool discovery completed")
		.split("\n")
		.map(line => theme.fg("dim", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}

/**
 * SearchToolsTool — wire name `search_tool_bm25` (preserved for persisted session back-compat).
 *
 * When tools.discoveryMode === "all", this covers both MCP tools and built-in discoverable tools.
 * When tools.discoveryMode === "mcp-only" or mcp.discoveryMode === true, only MCP tools are searched.
 */
export class SearchToolBm25Tool implements AgentTool<typeof searchToolBm25Schema, SearchToolBm25Details> {
	readonly name = "search_tool_bm25";
	readonly approval = "read" as const;
	readonly label = "SearchTools";
	readonly loadMode = "essential";
	get description(): string {
		return renderSearchToolBm25Description(getDiscoverableToolsForDescription(this.session));
	}
	readonly parameters = searchToolBm25Schema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SearchToolBm25Tool | null {
		// Active when new tools.discoveryMode is non-"off" or legacy mcp.discoveryMode is true
		const toolsDiscoveryMode = session.settings.get("tools.discoveryMode");
		const active =
			(toolsDiscoveryMode !== undefined && toolsDiscoveryMode !== "off") ||
			session.settings.get("mcp.discoveryMode") === true;
		if (!active) return null;
		return supportsToolDiscoveryExecution(session) ? new SearchToolBm25Tool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolBm25Params,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolBm25Details>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolBm25Details>> {
		if (!supportsToolDiscoveryExecution(this.session)) {
			throw new ToolError("Tool discovery is unavailable in this session.");
		}
		if (!isDiscoveryEnabled(this.session)) {
			throw new ToolError(
				"Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.",
			);
		}

		let action = params.action;
		if (!action) {
			action = params.tool ? "select" : "search";
		}

		if (action === "select") {
			if (!params.tool) {
				throw new ToolError("integration action 'select' requires the chosen `tool` name");
			}
			if (!params.reason || params.reason.length < 40) {
				throw new ToolError("integration action 'select' requires a `reason` of at least 40 characters");
			}
			const category = params.category ?? "unknown";
			const toolName = params.tool.trim();

			const searchIndex = getDiscoverableToolSearchIndexForExecution(this.session);
			const normalizedToolName = toolName.toLowerCase();
			const inCatalog = searchIndex.documents.some(
				d => d.tool.name.toLowerCase() === normalizedToolName || d.tool.label.toLowerCase() === normalizedToolName,
			);

			if (!inCatalog) {
				const span = trace.getActiveSpan();
				if (span) {
					span.setAttribute("aery.gen_ai.discovery.outcome", "off_catalog_select");
					span.setAttribute("aery.gen_ai.discovery.category", category);
					span.setAttribute("aery.gen_ai.discovery.off_catalog_tool", toolName);
				}

				const details: SearchToolBm25Details = {
					action: "select",
					query: params.query || "",
					limit: params.limit ?? DEFAULT_LIMIT,
					total_tools: searchIndex.documents.length,
					activated_tools: [],
					active_selected_tools: getSelectedToolNames(this.session),
					tools: [],
					selected_tool: toolName,
					catalog_tool: false,
					category,
				};

				return {
					content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
					details,
				};
			}

			const activated = await activateTools(this.session, [normalizedToolName]);
			const details: SearchToolBm25Details = {
				action: "select",
				query: params.query || "",
				limit: params.limit ?? DEFAULT_LIMIT,
				total_tools: searchIndex.documents.length,
				activated_tools: activated,
				active_selected_tools: getSelectedToolNames(this.session),
				tools: [],
				selected_tool: toolName,
				catalog_tool: true,
				category,
			};

			return {
				content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
				details,
			};
		}

		if (action === "suggest") {
			if (params.tool) {
				throw new ToolError(
					"integration action 'suggest' cannot include `tool`; use `product_name` for a known product",
				);
			}
			const details: SearchToolBm25Details = {
				action: "suggest",
				query: params.query || "",
				limit: params.limit ?? DEFAULT_LIMIT,
				total_tools: getDiscoverableToolSearchIndexForExecution(this.session).documents.length,
				activated_tools: [],
				active_selected_tools: getSelectedToolNames(this.session),
				tools: [],
				suggestion: params.product_name || "unknown",
			};
			return {
				content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
				details,
			};
		}

		const query = (params.query || "").trim();
		if (query.length === 0) {
			throw new ToolError("Query is required for search and must not be empty.");
		}
		const limit = params.limit ?? DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new ToolError("Limit must be a positive integer.");
		}

		const searchIndex = getDiscoverableToolSearchIndexForExecution(this.session);
		const selectedToolNames = new Set(getSelectedToolNames(this.session));
		let ranked: Array<{ tool: DiscoverableTool; score: number }> = [];
		try {
			ranked = searchDiscoverableTools(searchIndex, query, searchIndex.documents.length)
				.filter(result => !selectedToolNames.has(result.tool.name))
				.slice(0, limit);
		} catch (error) {
			if (error instanceof Error) {
				throw new ToolError(error.message);
			}
			throw error;
		}
		const activated =
			ranked.length > 0
				? await activateTools(
						this.session,
						ranked.map(result => result.tool.name),
					)
				: [];

		const details: SearchToolBm25Details = {
			action: "search",
			query,
			limit,
			total_tools: searchIndex.documents.length,
			activated_tools: activated,
			active_selected_tools: getSelectedToolNames(this.session),
			tools: ranked.map(result => formatMatch(result.tool, result.score)),
		};

		return {
			content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
			details,
		};
	}
}

export const searchToolBm25Renderer = {
	renderCall(args: SearchToolBm25Params, _options: RenderResultOptions, uiTheme: Theme): Component {
		let description = "(empty query)";
		if (args.action === "select" || args.tool) {
			description = `Selecting '${args.tool}'`;
		} else if (args.action === "suggest") {
			description = `Suggesting '${args.product_name}'`;
		} else {
			const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
			description = query || "(empty query)";
		}

		const meta = args.limit ? [`limit:${args.limit}`] : [];
		if (args.action) meta.push(`action:${args.action}`);

		return new Text(
			renderStatusLine({ icon: "pending", title: TOOL_DISCOVERY_TITLE, description, meta }, uiTheme),
			0,
			0,
		);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolBm25Details; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (!result.details) {
			const fallbackText = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.filter((text): text is string => typeof text === "string" && text.length > 0)
				.join("\n");
			return renderFallbackResult(fallbackText, uiTheme);
		}

		const { details } = result;
		if (details.action === "select") {
			const header = renderStatusLine(
				{ icon: "success", title: TOOL_DISCOVERY_TITLE, description: `Selected '${details.selected_tool}'` },
				uiTheme,
			);
			return new Text(header, 0, 0);
		}
		if (details.action === "suggest") {
			const header = renderStatusLine(
				{ icon: "success", title: TOOL_DISCOVERY_TITLE, description: `Suggested '${details.suggestion}'` },
				uiTheme,
			);
			return new Text(header, 0, 0);
		}

		const meta = [
			formatCount("match", details.tools.length),
			`${details.active_selected_tools.length} active`,
			`${details.total_tools} total`,
			`limit:${details.limit}`,
		];
		const safeQuery = replaceTabs(details.query);
		const header = renderStatusLine(
			{
				icon: details.tools.length > 0 ? "success" : "warning",
				title: TOOL_DISCOVERY_TITLE,
				description: truncateToWidth(safeQuery, MATCH_LABEL_LEN),
				meta,
			},
			uiTheme,
		);
		if (details.tools.length === 0) {
			const emptyMessage =
				details.total_tools === 0 ? "No discoverable tools are currently loaded." : "No matching tools found.";
			return new Text(`${header}\n${uiTheme.fg("muted", emptyMessage)}`, 0, 0);
		}

		const lines = [header];
		const treeLines = renderTreeList(
			{
				items: details.tools,
				expanded: options.expanded,
				maxCollapsed: COLLAPSED_MATCH_LIMIT,
				itemType: "tool",
				renderItem: match => renderMatchLines(match, uiTheme),
			},
			uiTheme,
		);
		lines.push(...treeLines);
		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
	inline: true,
};
