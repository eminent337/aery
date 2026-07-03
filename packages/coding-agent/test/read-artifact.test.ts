import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@aryee337/aery/config/settings";
import type { ToolSession } from "@aryee337/aery/tools";
import type { ReadToolDetails } from "@aryee337/aery/tools/read";
import { ReadTool } from "@aryee337/aery/tools/read";
import type { AgentToolResult } from "@aryee337/aery-core";

let artifactCounter = 0;

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	const settings = Settings.isolated({
		"read.summarize.minTotalLines": 0,
		"read.summarize.unfoldUntil": 0,
		"read.summarize.unfoldLimit": 0,
		...overrides,
	});
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			await fs.mkdir(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
	};
}

describe("read tool artifacts", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("writes full file contents to session artifacts when disk read is truncated", async () => {
		const fixture = path.join(tmpDir, "fixture.txt");
		// Create a file with many lines to trigger truncation
		const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
		const fullContent = lines.join("\n");
		await fs.writeFile(fixture, fullContent);

		// Configure read tool to have a very low limit to force truncation
		const tool = new ReadTool(
			createSession(tmpDir, {
				"read.defaultLimit": 5,
				"read.summarize.enabled": false,
			}),
		);

		const result = await tool.execute("read-truncated-disk", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("[raw output: artifact://artifact-");
		const match = text.match(/\[raw output: artifact:\/\/(artifact-\d+)\]/);
		expect(match).not.toBeNull();
		const artifactId = match![1];

		// Verify the artifact file exists and contains the full file content
		const sessionDir = path.join(tmpDir, "session");
		const artifactPath = path.join(sessionDir, `${artifactId}.read.log`);
		const savedContent = await fs.readFile(artifactPath, "utf8");
		expect(savedContent).toBe(fullContent);
	});

	it("writes full notebook representation to session artifacts when notebook read is truncated", async () => {
		const fixture = path.join(tmpDir, "notebook.ipynb");
		const notebookData = {
			cells: Array.from({ length: 100 }, (_, i) => ({
				cell_type: "code",
				execution_count: i + 1,
				metadata: {},
				outputs: [],
				source: [`print("${i + 1}: ${"A".repeat(2048)}")`],
			})),
			metadata: {},
			nbformat: 4,
			nbformat_minor: 2,
		};
		await fs.writeFile(fixture, JSON.stringify(notebookData, null, 2));

		const tool = new ReadTool(
			createSession(tmpDir, {
				"read.defaultLimit": 2,
				"read.summarize.enabled": false,
			}),
		);

		const result = await tool.execute("read-truncated-notebook", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("[raw output: artifact://artifact-");
		const match = text.match(/\[raw output: artifact:\/\/(artifact-\d+)\]/);
		expect(match).not.toBeNull();
		const artifactId = match![1];

		// Verify the artifact file exists and contains the notebook representation
		const sessionDir = path.join(tmpDir, "session");
		const artifactPath = path.join(sessionDir, `${artifactId}.read.log`);
		const savedContent = await fs.readFile(artifactPath, "utf8");
		expect(savedContent).toContain("# %% [code] cell:0");
		expect(savedContent).toContain("# %% [code] cell:99");
	});
});
