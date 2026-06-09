import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { GraphTool } from "./graph";

test("GraphTool parses dependencies correctly", async () => {
	const fixtureDir = path.join(__dirname, "fixtures");
	fs.mkdirSync(fixtureDir, { recursive: true });
	fs.writeFileSync(path.join(fixtureDir, "a.ts"), "import { b } from './b';\nrequire('node:fs');");
	fs.writeFileSync(path.join(fixtureDir, "b.ts"), "export const b = 1;");

	const tool = new GraphTool();
	const result = await tool.execute("test-id", { entryPoint: path.join(fixtureDir, "a.ts"), maxDepth: 10 });

	expect(result.details?.nodes.length).toBeGreaterThan(0);
	expect(result.details?.edges.length).toBeGreaterThan(0);

	// Cleanup
	fs.rmSync(fixtureDir, { recursive: true, force: true });
});
