import { describe, expect, it } from "bun:test";
import {
	FileIndex,
	FastFileSearchTool,
	fastFileSearchSchema,
} from "../src/tools/file-indexer";

describe("Bit-Parallel Fast File Indexer", () => {
	const samplePaths = [
		"packages/coding-agent/src/tools/desktop-control.ts",
		"packages/coding-agent/src/tools/desktop-drivers.ts",
		"packages/coding-agent/src/tools/native-bridge.ts",
		"packages/coding-agent/src/tools/live-input.ts",
		"packages/coding-agent/src/tools/quick-launcher.ts",
		"packages/coding-agent/src/tools/computer-use-teach.ts",
		"packages/coding-agent/test/native-bridge.test.ts",
		"docs/specs/desktop-control-design.md",
		"README.md",
		"package.json",
	];

	it("builds index and performs fuzzy searches with bitwise pruning", () => {
		const index = new FileIndex();
		index.loadFromFileList(samplePaths);
		expect(index.isFullyBuilt).toBe(true);

		const results = index.search("nativebridge", 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results.some(r => r.path.includes("native-bridge.ts"))).toBe(true);

		const quickResults = index.search("quicklauncher", 5);
		expect(quickResults.length).toBeGreaterThan(0);
		expect(quickResults[0].path).toBe("packages/coding-agent/src/tools/quick-launcher.ts");
	});

	it("scores word boundaries higher than random substrings", () => {
		const index = new FileIndex();
		index.loadFromFileList([
			"src/desktop-control.ts",
			"src/suboptimaldesktopcontrolfile.ts",
		]);

		const res = index.search("dc", 5);
		expect(res.length).toBe(2);
		expect(res[0].path).toBe("src/desktop-control.ts");
	});

	it("validates fastFileSearchSchema and tool execution", async () => {
		const parsed = fastFileSearchSchema.parse({
			action: "search",
			query: "desktop",
			limit: 10,
		});
		expect(parsed.action).toBe("search");
		expect(parsed.query).toBe("desktop");

		const tool = new FastFileSearchTool();
		tool.setPathsForTesting(samplePaths);

		const searchRes = await tool.execute("call-1", {
			action: "search",
			query: "bridge",
			limit: 5,
		});
		expect(searchRes.isError).toBeFalsy();
		expect(searchRes.content[0].text).toContain("native-bridge.ts");
	});
});
