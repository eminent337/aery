import { describe, expect, it } from "bun:test";
import { MemoryGraph, type MemoryGraphEdge } from "@aryee337/aery/memory/graph";

describe("memory graph", () => {
	it("adds nodes and edges via link()", () => {
		const g = new MemoryGraph();
		g.link("a", "b", 0.5);
		expect(g.hasNode("a")).toBe(true);
		expect(g.hasNode("b")).toBe(true);
		expect(g.getEdge("a", "b")).toBe(0.5);
		expect(g.nodeCount()).toBe(2);
		expect(g.edgeCount()).toBe(1);
	});

	it("link() keeps the higher weight when an edge already exists", () => {
		const g = new MemoryGraph();
		g.link("a", "b", 0.3);
		g.link("a", "b", 0.7);
		expect(g.getEdge("a", "b")).toBe(0.7);
		expect(g.edgeCount()).toBe(1);
	});

	it("related() does bounded BFS up to depth hops", () => {
		// a -> b -> c -> d (depth 3 chain)
		const g = new MemoryGraph();
		g.link("a", "b", 1);
		g.link("b", "c", 1);
		g.link("c", "d", 1);

		const atDepth1 = g.related("a", 1);
		expect(atDepth1.length).toBe(1);
		expect(atDepth1[0]!.id).toBe("b");
		expect(atDepth1[0]!.depth).toBe(1);

		const atDepth2 = g.related("a", 2);
		// c has cumulative weight 2 (a->b->c), b has weight 1
		expect(atDepth2.map(r => r.id)).toEqual(["c", "b"]);
		expect(atDepth2[0]!.depth).toBe(2);
		expect(atDepth2[1]!.depth).toBe(1);

		const atDepth3 = g.related("a", 3);
		// d has weight 3, c has weight 2, b has weight 1
		expect(atDepth3.map(r => r.id)).toEqual(["d", "c", "b"]);
	});

	it("related() ranks by cumulative weight, then by depth", () => {
		const g = new MemoryGraph();
		// a -> b (weight 1), a -> c (weight 5)
		g.link("a", "b", 1);
		g.link("a", "c", 5);

		const results = g.related("a", 1);
		expect(results.length).toBe(2);
		expect(results[0]!.id).toBe("c"); // higher weight
		expect(results[0]!.weight).toBe(5);
		expect(results[1]!.id).toBe("b");
		expect(results[1]!.weight).toBe(1);
	});

	it("related() returns empty for unknown start node", () => {
		const g = new MemoryGraph();
		g.link("a", "b", 1);
		expect(g.related("unknown", 2)).toEqual([]);
	});

	it("forget() removes a node and all incident edges", () => {
		const g = new MemoryGraph();
		g.link("a", "b", 1);
		g.link("b", "c", 1);
		g.link("c", "a", 1);

		expect(g.forget("b")).toBe(true);
		expect(g.hasNode("b")).toBe(false);
		expect(g.getEdge("a", "b")).toBeNull();
		expect(g.getEdge("b", "c")).toBeNull();
		// c -> a should remain
		expect(g.getEdge("c", "a")).toBe(1);
		expect(g.nodeCount()).toBe(2);
	});

	it("forget() returns false for unknown node", () => {
		const g = new MemoryGraph();
		expect(g.forget("nope")).toBe(false);
	});

	it("serializes and deserializes round-trip", () => {
		const g = new MemoryGraph();
		g.link("a", "b", 0.5);
		g.link("b", "c", 0.3);
		g.link("a", "c", 0.9);

		const json = g.toJSON();
		const restored = MemoryGraph.fromJSON(json);
		expect(restored.getEdge("a", "b")).toBe(0.5);
		expect(restored.getEdge("b", "c")).toBe(0.3);
		expect(restored.getEdge("a", "c")).toBe(0.9);
		expect(restored.nodeCount()).toBe(3);
	});

	it("versioned serialize/deserialize round-trip", () => {
		const g = new MemoryGraph();
		g.link("x", "y", 0.1);
		const serialized = g.serialize();
		const restored = MemoryGraph.deserialize(serialized);
		expect(restored.getEdge("x", "y")).toBe(0.1);
	});

	it("deserialize throws on unsupported version", () => {
		const record = { version: 999, edges: [] as MemoryGraphEdge[] };
		expect(() => MemoryGraph.deserialize(record)).toThrow();
	});

	it("related() finds the best path when multiple paths exist", () => {
		const g = new MemoryGraph();
		// a -> b -> d (cumulative 1 + 1 = 2)
		// a -> d (direct, weight 1)
		g.link("a", "b", 1);
		g.link("b", "d", 1);
		g.link("a", "d", 1);

		const results = g.related("a", 2);
		const d = results.find(r => r.id === "d");
		// The a->b->d path has cumulative weight 2, which is better than direct 1
		expect(d).toBeDefined();
		expect(d!.weight).toBe(2);
		expect(d!.depth).toBe(2);
	});
});
