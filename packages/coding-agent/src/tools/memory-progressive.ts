import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { ProgressiveMemoryStore } from "../memory/progressive-memory-store";
import type { ObservationRecord } from "../memory/types";
import type { ToolSession } from "./index";

export function formatRelativeAge(timestamp: number, now = Date.now()): string {
	const diffMs = Math.max(0, now - timestamp);
	const minutes = Math.floor(diffMs / 60000);
	if (minutes < 1) return "just now";
	const hours = Math.floor(minutes / 60);
	if (hours < 1) return `${minutes}m ago`;
	const days = Math.floor(hours / 24);
	if (days < 1) return `${hours}h ago`;
	return `${days}d ago`;
}

export function formatObservationMarkdown(obs: ObservationRecord): string {
	const timestamp = new Date(obs.createdAt).toISOString();
	const filesStr = obs.files && obs.files.length > 0 ? obs.files.map(f => `\`${f}\``).join(", ") : "(none)";
	const hasDetail = obs.context && Object.keys(obs.context).length > 0;
	const detailSection = hasDetail ? `\n\`\`\`json\n${JSON.stringify(obs.context, null, 2)}\n\`\`\`` : " (none)";

	return [
		`### Observation: ${obs.id}`,
		`- **ID**: ${obs.id}`,
		`- **Category**: ${obs.category}`,
		`- **Title**: ${obs.title}`,
		`- **Summary**: ${obs.summary}`,
		`- **Files**: ${filesStr}`,
		`- **Timestamp**: ${timestamp}`,
		`- **Detail**:${detailSection}`,
	].join("\n");
}

export function formatSearchObservationItem(obs: ObservationRecord, now = Date.now()): string {
	const age = formatRelativeAge(obs.createdAt, now);
	const filesStr = obs.files && obs.files.length > 0 ? obs.files.map(f => `\`${f}\``).join(", ") : "(none)";

	return [
		`- **[\`${obs.id}\`]** (\`${obs.category}\`) **${obs.title}** (${age})`,
		`  - **Summary**: ${obs.summary}`,
		`  - **Files**: ${filesStr}`,
	].join("\n");
}

export function formatSearchResultsMarkdown(results: ObservationRecord[], now = Date.now()): string {
	return results.map(obs => formatSearchObservationItem(obs, now)).join("\n");
}

export const memoryRecallSchema = z.object({
	id: z.string().describe("Observation ID to recall (e.g. obs-1)"),
});

export type MemoryRecallParams = z.infer<typeof memoryRecallSchema>;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "memory_recall";
	readonly approval = "read" as const;
	readonly label = "Memory Recall";
	readonly description = "Recall full details of a specific project observation by ID (e.g. obs-1).";
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Recall full observation details by ID from project memory";

	private store?: ProgressiveMemoryStore;

	constructor(
		private readonly session: ToolSession,
		store?: ProgressiveMemoryStore,
	) {
		this.store = store;
	}

	private getStore(): ProgressiveMemoryStore {
		if (this.store) {
			return this.store;
		}
		if (this.session.progressiveMemoryCoordinator) {
			return this.session.progressiveMemoryCoordinator.getStore();
		}
		const dbPath =
			this.session.settings?.get?.("memory.progressive.dbPath") ??
			path.join(this.session.cwd, ".aery", "memory", "project-memory.db");
		this.store = new ProgressiveMemoryStore({ dbPath });
		return this.store;
	}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		if (session.settings?.get?.("memory.progressive.enabled") === false) {
			return null;
		}
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams): Promise<AgentToolResult> {
		const store = this.getStore();
		const observation = store.getObservation(params.id);

		if (!observation) {
			return {
				content: [
					{
						type: "text",
						text: `Observation "${params.id}" not found in project memory.`,
					},
				],
				details: { id: params.id, found: false },
			};
		}

		const formatted = formatObservationMarkdown(observation);
		return {
			content: [
				{
					type: "text",
					text: formatted,
				},
			],
			details: {
				observation,
				found: true,
			},
		};
	}
}

export const memorySearchSchema = z.object({
	query: z.string().describe("Natural language search query"),
	category: z
		.enum(["decision", "bugfix", "discovery", "feature"])
		.optional()
		.describe("Filter by observation category"),
	limit: z.number().int().positive().optional().describe("Maximum results to return (default: 5)"),
});

export type MemorySearchParams = z.infer<typeof memorySearchSchema>;

export class MemorySearchTool implements AgentTool<typeof memorySearchSchema> {
	readonly name = "memory_search";
	readonly approval = "read" as const;
	readonly label = "Memory Search";
	readonly description = "Search project observations using full-text search with optional category filtering.";
	readonly parameters = memorySearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search project memory for relevant historical observations";

	private store?: ProgressiveMemoryStore;

	constructor(
		private readonly session: ToolSession,
		store?: ProgressiveMemoryStore,
	) {
		this.store = store;
	}

	private getStore(): ProgressiveMemoryStore {
		if (this.store) {
			return this.store;
		}
		if (this.session.progressiveMemoryCoordinator) {
			return this.session.progressiveMemoryCoordinator.getStore();
		}
		const dbPath =
			this.session.settings?.get?.("memory.progressive.dbPath") ??
			path.join(this.session.cwd, ".aery", "memory", "project-memory.db");
		this.store = new ProgressiveMemoryStore({ dbPath });
		return this.store;
	}

	static createIf(session: ToolSession): MemorySearchTool | null {
		if (session.settings?.get?.("memory.progressive.enabled") === false) {
			return null;
		}
		return new MemorySearchTool(session);
	}

	async execute(_id: string, params: MemorySearchParams): Promise<AgentToolResult> {
		const store = this.getStore();
		const results = store.searchObservations({
			query: params.query,
			category: params.category,
			limit: params.limit ?? 5,
		});

		if (results.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No observations matching "${params.query}" found in project memory.`,
					},
				],
				details: {
					query: params.query,
					category: params.category,
					results: [],
					count: 0,
				},
			};
		}

		const formatted = formatSearchResultsMarkdown(results);
		return {
			content: [
				{
					type: "text",
					text: formatted,
				},
			],
			details: {
				query: params.query,
				category: params.category,
				results,
				count: results.length,
			},
		};
	}
}

export function createMemoryRecallTool(session: ToolSession, store?: ProgressiveMemoryStore): MemoryRecallTool {
	return new MemoryRecallTool(session, store);
}

export function createMemorySearchTool(session: ToolSession, store?: ProgressiveMemoryStore): MemorySearchTool {
	return new MemorySearchTool(session, store);
}
