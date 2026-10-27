import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEditMode } from "../../utils/edit-mode";
import { EditFileTool } from "../edit-file";
import { DEFAULT_ESSENTIAL_TOOL_NAMES } from "../index";

describe("EditFileTool (ported from agy)", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-editfile-test-"));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("automatically includes edit_file in DEFAULT_ESSENTIAL_TOOL_NAMES", () => {
		expect(DEFAULT_ESSENTIAL_TOOL_NAMES).toContain("edit_file");
	});

	it("automatically selects 'replace' mode for Gemini and Google models", () => {
		const mockGeminiSession = {
			settings: { get: () => "hashline", getEditVariantForModel: () => null },
			getActiveModelString: () => "google-antigravity/gemini-3.1-pro-high",
		};
		expect(resolveEditMode(mockGeminiSession)).toBe("replace");

		const mockGeminiCliSession = {
			settings: { get: () => "hashline", getEditVariantForModel: () => null },
			getActiveModelString: () => "google-gemini-cli/gemini-2.5-flash",
		};
		expect(resolveEditMode(mockGeminiCliSession)).toBe("replace");
	});

	it("replaces exact string in sub-millisecond time", async () => {
		const filePath = path.join(tempDir, "sample.ts");
		const original = `function add(a: number, b: number): number {\n\treturn a + b;\n}`;
		await fs.writeFile(filePath, original, "utf-8");

		const tool = new EditFileTool();
		const result = await tool.execute("call-1", {
			Path: filePath,
			Target: "return a + b;",
			Replacement: "return (a + b) * 2;",
		});

		expect((result.content[0] as any).text).toContain("Successfully replaced");
		const updated = await fs.readFile(filePath, "utf-8");
		expect(updated).toContain("return (a + b) * 2;");
	});

	it("throws ToolError when Target is not found", async () => {
		const filePath = path.join(tempDir, "sample.ts");
		await fs.writeFile(filePath, "const x = 10;", "utf-8");

		const tool = new EditFileTool();
		expect(
			tool.execute("call-2", {
				Path: filePath,
				Target: "const nonExistent = 999;",
				Replacement: "const replaced = 1;",
			}),
		).rejects.toThrow("Target string was not found");
	});

	it("supports lowercase path, target, replacement aliases", async () => {
		const filePath = path.join(tempDir, "sample2.ts");
		await fs.writeFile(filePath, "const name = 'old';", "utf-8");

		const tool = new EditFileTool();
		await tool.execute("call-3", {
			path: filePath,
			target: "'old'",
			replacement: "'new'",
		});

		const updated = await fs.readFile(filePath, "utf-8");
		expect(updated).toBe("const name = 'new';");
	});
});
