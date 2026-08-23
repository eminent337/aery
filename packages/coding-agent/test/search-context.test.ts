import { describe, expect, it } from "bun:test";
import { SearchContext } from "@aryee337/aery/search/context";

describe("search context", () => {
	it("records files, regions, and symbols with default confidence", () => {
		const ctx = new SearchContext();
		ctx.recordFile({ path: "src/foo.ts" });
		ctx.recordRegion({ path: "src/bar.ts", startLine: 10, endLine: 20 });
		ctx.recordSymbol({ path: "src/baz.ts", symbol: "myFunction" });

		expect(ctx.knownFiles.length).toBe(1);
		expect(ctx.knownRegions.length).toBe(1);
		expect(ctx.knownSymbols.length).toBe(1);

		expect(ctx.knownFiles[0]!.confidence.body).toBe(0.8);
		expect(ctx.knownRegions[0]!.confidence.body).toBe(0.7);
		expect(ctx.knownSymbols[0]!.confidence.body).toBe(0.75);
	});

	it("adds focus files", () => {
		const ctx = new SearchContext();
		ctx.addFocusFile("src/important.ts");
		ctx.addFocusFile("src/important.ts"); // duplicate ignored
		expect(ctx.focusFiles).toEqual(["src/important.ts"]);
	});

	it("gets file confidence", () => {
		const ctx = new SearchContext();
		ctx.recordFile({ path: "src/foo.ts", body: 0.9 });
		const confidence = ctx.getFileConfidence("src/foo.ts");
		expect(confidence).not.toBeNull();
		expect(confidence!.body).toBeCloseTo(0.9, 1);

		expect(ctx.getFileConfidence("src/unknown.ts")).toBeNull();
	});

	it("gets region confidence", () => {
		const ctx = new SearchContext();
		ctx.recordRegion({ path: "src/foo.ts", startLine: 5, endLine: 15, body: 0.85 });
		const confidence = ctx.getRegionConfidence("src/foo.ts", 5, 15);
		expect(confidence).not.toBeNull();
		expect(confidence!.body).toBeCloseTo(0.85, 1);

		expect(ctx.getRegionConfidence("src/foo.ts", 100, 200)).toBeNull();
	});

	it("prunes low-confidence entries", () => {
		const ctx = new SearchContext();
		ctx.recordFile({ path: "src/good.ts", body: 0.9, prune: 0.1 });
		ctx.recordFile({ path: "src/bad.ts", body: 0.1, prune: 0.9 });

		const pruned = ctx.prune(0.2);
		expect(pruned).toBeGreaterThanOrEqual(1);
		expect(ctx.knownFiles.length).toBeLessThanOrEqual(1);
	});

	it("clears all entries", () => {
		const ctx = new SearchContext();
		ctx.recordFile({ path: "src/foo.ts" });
		ctx.recordRegion({ path: "src/bar.ts", startLine: 1, endLine: 10 });
		ctx.addFocusFile("src/focus.ts");

		ctx.clear();
		expect(ctx.knownFiles.length).toBe(0);
		expect(ctx.knownRegions.length).toBe(0);
		expect(ctx.focusFiles.length).toBe(0);
	});

	it("serializes and deserializes round-trip", () => {
		const ctx = new SearchContext();
		ctx.recordFile({ path: "src/foo.ts" });
		ctx.recordRegion({ path: "src/bar.ts", startLine: 1, endLine: 10 });
		ctx.recordSymbol({ path: "src/baz.ts", symbol: "fn" });
		ctx.addFocusFile("src/focus.ts");

		const json = ctx.toJSON();
		const restored = SearchContext.fromJSON(json);
		expect(restored.knownFiles.length).toBe(1);
		expect(restored.knownRegions.length).toBe(1);
		expect(restored.knownSymbols.length).toBe(1);
		expect(restored.focusFiles.length).toBe(1);
	});

	it("deserialize throws on unsupported version", () => {
		const data = { version: 999, knownRegions: [], knownFiles: [], knownSymbols: [], focusFiles: [] };
		expect(() => SearchContext.fromJSON(data)).toThrow();
	});
});
