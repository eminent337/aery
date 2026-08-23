/**
 * Memory graph store — per-scope persistence for the memory graph.
 *
 * Stores graph data as JSON files in the agent directory, keyed by scope
 * (project hash or "global"). Mirrors jcode's project/global split.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MemoryGraph } from "./graph";

export interface MemoryGraphStoreOptions {
	/** Base directory for graph files (defaults to agent dir). */
	baseDir: string;
}

const GRAPH_FILENAME = "memory-graph.json";

/**
 * Loads the memory graph for a given scope, or an empty graph if none exists.
 */
export async function loadMemoryGraph(store: MemoryGraphStoreOptions, scope: string): Promise<MemoryGraph> {
	const filePath = getGraphPath(store, scope);
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		const data = JSON.parse(raw);
		return MemoryGraph.deserialize(data);
	} catch {
		return new MemoryGraph();
	}
}

/**
 * Saves the memory graph for a given scope.
 */
export async function saveMemoryGraph(
	store: MemoryGraphStoreOptions,
	scope: string,
	graph: MemoryGraph,
): Promise<void> {
	const filePath = getGraphPath(store, scope);
	const data = graph.serialize();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** Delete the graph for a scope. */
export async function deleteMemoryGraph(store: MemoryGraphStoreOptions, scope: string): Promise<void> {
	const filePath = getGraphPath(store, scope);
	try {
		await fs.unlink(filePath);
	} catch {
		// already gone
	}
}

function getGraphPath(store: MemoryGraphStoreOptions, scope: string): string {
	return path.join(store.baseDir, "memory", `${scope}-${GRAPH_FILENAME}`);
}
