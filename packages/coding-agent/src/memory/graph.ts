/**
 * Memory graph — weighted adjacency list with BFS traversal.
 *
 * Ported from jcode upstream (crates/jcode-base/src/memory.rs MemoryGraph):
 * the jcode graph layer provides link() / related() / forget() over memory
 * entries stored in a JSON file per scope (project/global). Aery's Mnemopi
 * backend provides vector recall but no graph structure — this module adds
 * that structure on top, persisted per scope.
 *
 * Design: adjacency list stored as { [fromId]: { [toId]: weight } }. link()
 * creates a directed weighted edge. related() does bounded BFS up to `depth`
 * hops, returning memories ranked by cumulative path weight. forget()
 * removes the node and all incident edges.
 */

export interface MemoryGraphNode {
	id: string;
	content: string;
}

export interface MemoryGraphEdge {
	fromId: string;
	toId: string;
	weight: number;
}

export interface RelatedMemory {
	id: string;
	content: string;
	weight: number;
	depth: number;
}

interface MemoryGraphData {
	edges: MemoryGraphEdge[];
}

const GRAPH_VERSION = 1;

/**
 * Weighted directed graph of memory entries.
 *
 * The graph is sparse: most memories have no edges. We store edges only;
 * node metadata (content) lives in the underlying memory store (Mnemopi).
 */
export class MemoryGraph {
	#adjacency: Map<string, Map<string, number>> = new Map();
	#nodes: Set<string> = new Set();

	/** Add a node (no-op if already present). */
	addNode(id: string): void {
		this.#nodes.add(id);
		if (!this.#adjacency.has(id)) {
			this.#adjacency.set(id, new Map());
		}
	}

	/** Remove a node and all incident edges. Returns true if the node existed. */
	removeNode(id: string): boolean {
		if (!this.#nodes.has(id)) return false;
		this.#nodes.delete(id);
		this.#adjacency.delete(id);
		// Remove incoming edges from other nodes.
		for (const edges of this.#adjacency.values()) {
			edges.delete(id);
		}
		return true;
	}

	hasNode(id: string): boolean {
		return this.#nodes.has(id);
	}

	nodeCount(): number {
		return this.#nodes.size;
	}

	edgeCount(): number {
		let count = 0;
		for (const edges of this.#adjacency.values()) {
			count += edges.size;
		}
		return count;
	}

	/**
	 * Create a directed weighted edge from -> to. Adds both nodes if missing.
	 * If the edge exists, the higher weight wins.
	 */
	link(fromId: string, toId: string, weight: number): void {
		this.addNode(fromId);
		this.addNode(toId);
		const edges = this.#adjacency.get(fromId)!;
		const existing = edges.get(toId);
		if (existing === undefined || weight > existing) {
			edges.set(toId, weight);
		}
	}

	/** Get the weight of a direct edge, or null if absent. */
	getEdge(fromId: string, toId: string): number | null {
		return this.#adjacency.get(fromId)?.get(toId) ?? null;
	}

	/** Get all outgoing edges from a node. */
	getEdges(id: string): ReadonlyMap<string, number> {
		return this.#adjacency.get(id) ?? new Map();
	}

	/**
	 * BFS traversal up to `depth` hops, returning connected memories ranked
	 * by cumulative path weight (desc). The start node is not included.
	 *
	 * Each result carries the depth of the best-weight path and the cumulative
	 * weight of that path.
	 */
	related(startId: string, depth = 2): RelatedMemory[] {
		if (!this.#nodes.has(startId)) return [];

		// Best (weight, depth) per visited node. We want max weight.
		const visited = new Map<string, { weight: number; depth: number }>();
		const queue: Array<{ id: string; depth: number; weight: number }> = [{ id: startId, depth: 0, weight: 0 }];

		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.depth >= depth) continue;

			const neighbors = this.#adjacency.get(current.id);
			if (!neighbors) continue;

			for (const [neighborId, edgeWeight] of neighbors) {
				const newWeight = current.weight + edgeWeight;
				const newDepth = current.depth + 1;
				const seen = visited.get(neighborId);

				if (seen === undefined) {
					visited.set(neighborId, { weight: newWeight, depth: newDepth });
					queue.push({ id: neighborId, depth: newDepth, weight: newWeight });
				} else if (newWeight > seen.weight) {
					// Found a better path: update and re-explore.
					seen.weight = newWeight;
					seen.depth = newDepth;
					queue.push({ id: neighborId, depth: newDepth, weight: newWeight });
				}
			}
		}

		const results: RelatedMemory[] = [];
		for (const [id, info] of visited) {
			results.push({ id, content: "", weight: info.weight, depth: info.depth });
		}
		results.sort((a, b) => b.weight - a.weight || a.depth - b.depth);
		return results;
	}

	/** Forget a node: remove it and all incident edges. */
	forget(id: string): boolean {
		return this.removeNode(id);
	}

	/** Serialize to a JSON-compatible object. */
	toJSON(): MemoryGraphData {
		const edges: MemoryGraphEdge[] = [];
		for (const [fromId, outgoing] of this.#adjacency) {
			for (const [toId, weight] of outgoing) {
				edges.push({ fromId, toId, weight });
			}
		}
		return { edges };
	}

	/** Deserialize from a JSON object. */
	static fromJSON(data: MemoryGraphData): MemoryGraph {
		const graph = new MemoryGraph();
		for (const edge of data.edges) {
			graph.link(edge.fromId, edge.toId, edge.weight);
		}
		return graph;
	}

	/** Serialize to a storable record (includes version for forward migration). */
	serialize(): { version: number; edges: MemoryGraphEdge[] } {
		return { version: GRAPH_VERSION, ...this.toJSON() };
	}

	/** Deserialize from a stored record. */
	static deserialize(record: { version: number; edges: MemoryGraphEdge[] }): MemoryGraph {
		if (record.version !== GRAPH_VERSION) {
			throw new Error(`Unsupported memory graph version: ${record.version}`);
		}
		return MemoryGraph.fromJSON({ edges: record.edges });
	}
}

export { GRAPH_VERSION };
