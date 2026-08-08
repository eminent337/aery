import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverBaseSystemPromptFile, resolvePromptInput } from "../src/system-prompt";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-system-prompt-test-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("System Prompt Utils", () => {
	describe("discoverBaseSystemPromptFile", () => {
		test("finds project .aery/system-prompt.md", async () => {
			await withTempDir(async dir => {
				const aeryDir = path.join(dir, ".aery");
				await fs.mkdir(aeryDir);
				await fs.writeFile(path.join(aeryDir, "system-prompt.md"), "project test");

				const discovered = discoverBaseSystemPromptFile(dir);
				expect(discovered).toBe(path.join(aeryDir, "system-prompt.md"));
			});
		});

		test("returns undefined when no file exists", async () => {
			await withTempDir(async dir => {
				const discovered = discoverBaseSystemPromptFile(dir);
				expect(discovered).toBeUndefined();
			});
		});
	});

	describe("resolvePromptInput", () => {
		test("trims whitespace from literal strings", async () => {
			const input = "  You are an agent.  \n";
			const result = await resolvePromptInput(input, "test");
			expect(result).toBe("You are an agent.");
		});

		test("returns undefined for whitespace-only literal strings", async () => {
			const input = "   \n   ";
			const result = await resolvePromptInput(input, "test");
			expect(result).toBeUndefined();
		});

		test("returns undefined for empty input", async () => {
			const result = await resolvePromptInput("", "test");
			expect(result).toBeUndefined();
		});

		test("reads and trims file content", async () => {
			await withTempDir(async dir => {
				const filePath = path.join(dir, "test.md");
				await fs.writeFile(filePath, "  File content here.  \n");

				const result = await resolvePromptInput(filePath, "test");
				expect(result).toBe("File content here.");
			});
		});

		test("returns undefined for whitespace-only file content", async () => {
			await withTempDir(async dir => {
				const filePath = path.join(dir, "test.md");
				await fs.writeFile(filePath, "   \n   ");

				const result = await resolvePromptInput(filePath, "test");
				expect(result).toBeUndefined();
			});
		});
	});
});
