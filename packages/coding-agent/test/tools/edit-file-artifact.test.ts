/**
 * Tests for EditFileTool ArtifactMetadata support (agy parity — Workstream 3).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EditFileTool } from "../../src/tools/edit-file";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content[0];
	return c?.type === "text" && c.text ? c.text : "";
}

const makeSession = (cwd: string) => ({
	cwd,
	hasUI: false as const,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: {} as any,
});

describe("EditFileTool — ArtifactMetadata", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-file-artifact-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("performs basic replacement without ArtifactMetadata", async () => {
		const filePath = path.join(tmpDir, "sample.txt");
		await fs.writeFile(filePath, "Hello, World!", "utf-8");

		const tool = new EditFileTool(makeSession(tmpDir));
		const result = await tool.execute("test-1", {
			Path: filePath,
			Target: "World",
			Replacement: "Aery",
		});

		expect(getText(result as any)).toContain("Successfully replaced");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toBe("Hello, Aery!");
	});

	it("updates artifact metadata when ArtifactMetadata is provided", async () => {
		const filePath = path.join(tmpDir, "plan.md");
		await fs.writeFile(filePath, "# Plan\n\nOld content here.", "utf-8");

		const tool = new EditFileTool(makeSession(tmpDir));
		const result = await tool.execute("test-2", {
			Path: filePath,
			Target: "Old content here.",
			Replacement: "New updated content.",
			ArtifactMetadata: {
				Summary: "Updated implementation plan",
				UserFacing: true,
				RequestFeedback: false,
			},
		});

		const text = getText(result as any);
		expect(text).toContain("Successfully replaced");
		expect(text).toContain("Updated implementation plan");

		// File content should be updated
		const fileContent = await fs.readFile(filePath, "utf-8");
		expect(fileContent).toContain("New updated content.");

		// Details should include artifact with metadata
		const details = result.details as Record<string, unknown>;
		expect(details.artifact).toBeDefined();
		const artifact = details.artifact as Record<string, unknown>;
		const metadata = artifact.metadata as Record<string, unknown>;
		expect(metadata.summary).toBe("Updated implementation plan");
		expect(metadata.userFacing).toBe(true);
	});

	it("includes Feedback Requested note when RequestFeedback is true", async () => {
		const filePath = path.join(tmpDir, "feature.md");
		await fs.writeFile(filePath, "Step 1: Do this.", "utf-8");

		const tool = new EditFileTool(makeSession(tmpDir));
		const result = await tool.execute("test-3", {
			Path: filePath,
			Target: "Step 1: Do this.",
			Replacement: "Step 1: Do that instead.",
			ArtifactMetadata: {
				Summary: "Feature plan updated",
				UserFacing: true,
				RequestFeedback: true,
			},
		});

		expect(getText(result as any)).toContain("Feedback Requested");
	});

	it("supports lowercase artifactMetadata alias (agy compatibility)", async () => {
		const filePath = path.join(tmpDir, "notes.md");
		await fs.writeFile(filePath, "Draft version.", "utf-8");

		const tool = new EditFileTool(makeSession(tmpDir));
		const result = await tool.execute("test-4", {
			Path: filePath,
			Target: "Draft version.",
			Replacement: "Final version.",
			artifactMetadata: {
				summary: "Notes finalized",
				userFacing: true,
				requestFeedback: false,
			},
		});

		expect(getText(result as any)).toContain("Notes finalized");
		const details = result.details as Record<string, unknown>;
		expect(details.artifact).toBeDefined();
	});

	it("throws ToolError when target not found", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		await fs.writeFile(filePath, "Some content here.", "utf-8");

		const tool = new EditFileTool(makeSession(tmpDir));

		expect(
			tool.execute("test-5", {
				Path: filePath,
				Target: "nonexistent string XYZ",
				Replacement: "replacement",
			}),
		).rejects.toThrow("Target string was not found");
	});
});
