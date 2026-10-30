/**
 * Tests for agy core tool parity:
 * - read_file
 * - write_file
 * - run_command
 * - search_web
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { ReadFileTool } from "../../src/tools/read-file";
import { WriteFileTool } from "../../src/tools/write-file";
import { RunCommandTool } from "../../src/tools/run-command";
import { SearchWebTool } from "../../src/tools/search-web";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content[0];
	return c?.type === "text" && c.text ? c.text : "";
}

const makeSession = (cwd: string) => ({
	cwd,
	hasUI: false as const,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: {
		get: (key: string) => {
			if (key === "async.enabled") return false;
			if (key === "bash.autoBackground.enabled") return false;
			return undefined;
		},
	} as any,
});

describe("ReadFileTool (agy read_file)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-file-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("has the correct name and approval tier", () => {
		const tool = new ReadFileTool(makeSession(tmpDir) as any);
		expect(tool.name).toBe("read_file");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("discoverable");
	});

	it("reads whole file contents using agy Path parameter", async () => {
		const filePath = path.join(tmpDir, "test.txt");
		await fs.writeFile(filePath, "Line 1\nLine 2\nLine 3\n", "utf-8");

		const tool = new ReadFileTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-1", { Path: filePath });

		const text = getText(result as any);
		expect(text).toContain("Line 1");
		expect(text).toContain("Line 3");
	});

	it("reads line range with StartLine and EndLine parameters", async () => {
		const filePath = path.join(tmpDir, "multiline.txt");
		const lines = Array.from({ length: 20 }, (_, i) => `Row ${i + 1}`).join("\n");
		await fs.writeFile(filePath, lines, "utf-8");

		const tool = new ReadFileTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-2", {
			Path: filePath,
			StartLine: 5,
			EndLine: 7,
		});

		const text = getText(result as any);
		expect(text).toContain("Row 5");
		expect(text).toContain("Row 7");
	});
});

describe("WriteFileTool (agy write_file)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-file-test-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("has the correct name and approval tier", () => {
		const tool = new WriteFileTool(makeSession(tmpDir) as any);
		expect(tool.name).toBe("write_file");
		expect(tool.approval).toBe("write");
		expect(tool.loadMode).toBe("discoverable");
	});

	it("creates a new file using agy Path and Content parameters", async () => {
		const filePath = path.join(tmpDir, "output.txt");
		const tool = new WriteFileTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-1", {
			Path: filePath,
			Content: "Created via write_file",
		});

		expect(getText(result as any)).toContain("Successfully wrote");
		const written = await fs.readFile(filePath, "utf-8");
		expect(written).toBe("Created via write_file");
	});

	it("appends content when Append is true", async () => {
		const filePath = path.join(tmpDir, "log.txt");
		await fs.writeFile(filePath, "Initial line\n", "utf-8");

		const tool = new WriteFileTool(makeSession(tmpDir) as any);
		await tool.execute("call-2", {
			Path: filePath,
			Content: "Appended line\n",
			Append: true,
		});

		const written = await fs.readFile(filePath, "utf-8");
		expect(written).toBe("Initial line\nAppended line\n");
	});

	it("rejects overwriting when Overwrite is explicitly false", async () => {
		const filePath = path.join(tmpDir, "locked.txt");
		await fs.writeFile(filePath, "Don't touch", "utf-8");

		const tool = new WriteFileTool(makeSession(tmpDir) as any);
		expect(
			tool.execute("call-3", {
				Path: filePath,
				Content: "New content",
				Overwrite: false,
			}),
		).rejects.toThrow("already exists");
	});

	it("saves artifact metadata when ArtifactMetadata is supplied", async () => {
		const filePath = path.join(tmpDir, "artifact.md");
		const tool = new WriteFileTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-4", {
			Path: filePath,
			Content: "# Architectural Plan\nDetails here",
			ArtifactMetadata: {
				Summary: "System architecture plan",
				UserFacing: true,
				RequestFeedback: true,
			},
		});

		const text = getText(result as any);
		expect(text).toContain("Successfully wrote artifact");
		expect(text).toContain("Feedback Requested");
	});
});

describe("RunCommandTool (agy run_command)", () => {
	it("has the correct name and approval tier", () => {
		const tool = new RunCommandTool(makeSession(process.cwd()) as any);
		expect(tool.name).toBe("run_command");
		expect(tool.approval).toBe("exec");
		expect(tool.loadMode).toBe("discoverable");
	});

	it("executes bash commands with CommandLine parameter", async () => {
		const tool = new RunCommandTool(makeSession(process.cwd()) as any);
		const result = await tool.execute("call-1", {
			CommandLine: "echo 'hello from run_command'",
			WaitMsBeforeAsync: 5000,
			toolSummary: "Echo check",
		});

		const text = getText(result as any);
		expect(text).toContain("hello from run_command");
	});
});

describe("SearchWebTool (agy search_web)", () => {
	it("has the correct name and approval tier", () => {
		const tool = new SearchWebTool(makeSession(process.cwd()) as any);
		expect(tool.name).toBe("search_web");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("discoverable");
	});
});
