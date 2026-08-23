/**
 * Memory related tool — BFS traversal over the memory graph from a starting memory.
 *
 * Ported from jcode upstream (crates/jcode-base/src/memory.rs related()).
 * Does a bounded breadth-first traversal up to `depth` hops, returning
 * connected memories ranked by cumulative path weight.
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { loadMemoryGraph } from "../memory/graph-store";
import { getMnemopiSessionState } from "../mnemopi/state";
import type { ToolSession } from "./index";

const memoryRelatedSchema = z.object({
	id: z.string().describe("Starting memory ID"),
	depth: z.number().int().min(1).max(5).optional().describe("BFS depth (default 2, max 5)"),
});

export type MemoryRelatedParams = z.infer<typeof memoryRelatedSchema>;

export class MemoryRelatedTool implements AgentTool<typeof memoryRelatedSchema> {
	readonly name = "memory_related";
	readonly approval = "read" as const;
	readonly label = "Memory Related";
	readonly description =
		"Find memories related to a starting memory via graph traversal (BFS up to depth hops, ranked by connection strength).";
	readonly parameters = memoryRelatedSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Find related memories via graph BFS";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRelatedTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mnemopi") return null;
		return new MemoryRelatedTool(session);
	}

	async execute(_id: string, params: MemoryRelatedParams): Promise<AgentToolResult> {
		const state = getMnemopiSessionState(this.session as never);
		if (!state) {
			return {
				content: [{ type: "text", text: "Mnemopi memory backend is not initialised." }],
				details: { error: "mnemopi_not_ready" },
			};
		}

		const depth = params.depth ?? 2;
		const scope = this.session.cwd ?? "global";
		const store = { baseDir: this.session.cwd ?? process.cwd() };
		const graph = await loadMemoryGraph(store, scope);

		if (!graph.hasNode(params.id)) {
			return {
				content: [{ type: "text", text: `Memory ${params.id} not found in the graph.` }],
				details: { id: params.id, found: false },
			};
		}

		const related = graph.related(params.id, depth);
		if (related.length === 0) {
			return {
				content: [{ type: "text", text: `No related memories found for ${params.id} within ${depth} hops.` }],
				details: { id: params.id, depth, results: 0 },
			};
		}

		const lines = [
			`## Related Memories for ${params.id}\n\nFound ${related.length} related memory/memories within ${depth} hops:\n`,
		];
		for (const mem of related) {
			lines.push(`- **${mem.id}** (depth ${mem.depth}, weight ${mem.weight.toFixed(2)})`);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { id: params.id, depth, results: related.length, topWeight: related[0]?.weight ?? 0 },
		};
	}
}
