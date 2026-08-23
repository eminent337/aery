/**
 * Memory link tool — create weighted edges between memories in the graph.
 *
 * Ported from jcode upstream (crates/jcode-base/src/memory.rs link()).
 * Creates a directed weighted edge between two memory IDs. The graph is
 * persisted per-scope (project/global).
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { loadMemoryGraph, saveMemoryGraph } from "../memory/graph-store";
import { getMnemopiSessionState } from "../mnemopi/state";
import type { ToolSession } from "./index";

const memoryLinkSchema = z.object({
	fromId: z.string().describe("Source memory ID"),
	toId: z.string().describe("Target memory ID"),
	weight: z.number().min(0).max(1).optional().describe("Edge weight 0-1 (default 0.5)"),
});

export type MemoryLinkParams = z.infer<typeof memoryLinkSchema>;

export class MemoryLinkTool implements AgentTool<typeof memoryLinkSchema> {
	readonly name = "memory_link";
	readonly approval = "read" as const;
	readonly label = "Memory Link";
	readonly description =
		"Create a weighted edge between two memories in the memory graph. Use to relate concepts, decisions, or facts for later traversal.";
	readonly parameters = memoryLinkSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Link two memories with a weighted edge";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryLinkTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mnemopi") return null;
		return new MemoryLinkTool(session);
	}

	async execute(_id: string, params: MemoryLinkParams): Promise<AgentToolResult> {
		const state = getMnemopiSessionState(this.session as never);
		if (!state) {
			return {
				content: [{ type: "text", text: "Mnemopi memory backend is not initialised." }],
				details: { error: "mnemopi_not_ready" },
			};
		}

		const weight = params.weight ?? 0.5;
		const scope = this.session.cwd ?? "global";
		const store = { baseDir: this.session.cwd ?? process.cwd() };
		const graph = await loadMemoryGraph(store, scope);
		graph.link(params.fromId, params.toId, weight);
		await saveMemoryGraph(store, scope, graph);

		return {
			content: [
				{
					type: "text",
					text: `Linked memory ${params.fromId} -> ${params.toId} (weight ${weight}). Graph now has ${graph.nodeCount()} nodes, ${graph.edgeCount()} edges.`,
				},
			],
			details: {
				fromId: params.fromId,
				toId: params.toId,
				weight,
				nodeCount: graph.nodeCount(),
				edgeCount: graph.edgeCount(),
			},
		};
	}
}
