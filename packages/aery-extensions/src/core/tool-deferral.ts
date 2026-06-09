/**
 * Tool Deferral Extension
 *
 * Defers rarely-used tools to save context tokens.
 * Model discovers deferred tools via tool_search.
 *
 * Config: ~/.aery/agent/tool-deferral.json
 *
 * {
 *   "deferred": ["notebook_edit", "mcp_list", "cron_create", ...],
 *   "alwaysLoad": ["bash", "read", "edit", "write", "grep", "find", "ls"]
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";
import { Type } from "@sinclair/typebox";

interface DeferralConfig {
	deferred: string[];
	alwaysLoad: string[];
}

function loadConfig(): DeferralConfig {
	const path = join(homedir(), ".aery", "agent", "tool-deferral.json");
	if (!existsSync(path)) {
		return {
			deferred: [
				"notebook_edit",
				"mcp_list",
				"mcp_list_resources",
				"mcp_read_resource",
				"cron_create",
				"cron_delete",
				"cron_list",
				"monitor",
				"lsp",
			],
			alwaysLoad: [
				"bash",
				"read",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"web_search",
				"web_fetch",
				"ask_user_question",
				"task_create",
				"task_list",
				"task_update",
				"skill",
			],
		};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { deferred: [], alwaysLoad: [] };
	}
}

export default function toolDeferral(aery: ExtensionAPI): void {
	const config = loadConfig();
	const deferredSet = new Set(config.deferred.map(n => n.toLowerCase()));
	// Tracks which tool names have been deferred (names only, since getAllTools returns strings)
	const deferredToolNames = new Set<string>();

	// On session start, deactivate deferred tools
	aery.on("session_start", () => {
		const allTools = aery.getAllTools(); // returns string[]
		const activeNames: string[] = [];

		for (const toolName of allTools) {
			if (deferredSet.has(toolName.toLowerCase())) {
				deferredToolNames.add(toolName);
			} else {
				activeNames.push(toolName);
			}
		}

		// Only set active tools if we actually deferred something
		if (deferredToolNames.size > 0) {
			aery.setActiveTools(activeNames);
		}
	});

	// Register tool_search for discovering deferred tools
	aery.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description:
			'Search for deferred tools by keyword. Use "select:<tool_name>" to activate a specific tool, or keywords to search descriptions.',
		parameters: Type.Object({
			query: Type.String({
				description: 'Search query. Use "select:<tool_name>" for direct activation, or keywords.',
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum results (default: 5)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { query, max_results: maxResults = 5 } = params as { query: string; max_results?: number };
			const queryTrimmed = query.trim();

			// Direct activation mode
			if (queryTrimmed.startsWith("select:")) {
				const toolName = queryTrimmed.slice("select:".length).trim();
				const found = [...deferredToolNames].find(n => n.toLowerCase() === toolName.toLowerCase());

				if (found) {
					const currentActive = aery.getActiveTools();
					await aery.setActiveTools([...currentActive, found]);
					deferredToolNames.delete(found);

					return {
						content: [
							{
								type: "text" as const,
								text: `Activated tool: ${found}`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `No deferred tool found: ${toolName}`,
						},
					],
				};
			}

			// Keyword search mode
			const queryLower = queryTrimmed.toLowerCase();
			const keywords = queryLower.split(/\s+/).filter((k: string) => k.length > 0);

			const scored = [...deferredToolNames]
				.map(name => {
					const nameLower = name.toLowerCase();
					let score = 0;
					if (nameLower === queryLower) score += 100;
					if (nameLower.includes(queryLower)) score += 50;
					for (const kw of keywords) {
						if (nameLower.includes(kw)) score += 20;
					}
					return { name, score };
				})
				.filter(item => item.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, maxResults);

			if (scored.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No deferred tools matching: "${queryTrimmed}"`,
						},
					],
				};
			}

			const lines = scored.map(s => `- ${s.name}`);

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${scored.length} deferred tools:\n${lines.join("\n")}\n\nUse 'select:<tool_name>' to activate.`,
					},
				],
			};
		},
	});
}
