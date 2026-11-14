import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractSessionPatches, runApplyCommand } from "../src/cli/apply-cli";

describe("Apply CLI Subsystem", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `aery-apply-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("extracts patches from write_file and edit_file tool calls", async () => {
		const targetFile = path.join(tempDir, "src", "sample.ts");
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		await fs.writeFile(targetFile, 'console.log("hello");\n', "utf8");

		const sessionFile = path.join(tempDir, "test-session.jsonl");
		const sessionEntries = [
			{
				type: "session",
				id: "sess_apply_test_1",
				timestamp: Date.now(),
				cwd: tempDir,
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "edit_file",
							arguments: {
								Path: targetFile,
								Target: 'console.log("hello");',
								Replacement: 'console.log("hello world");',
							},
						},
						{
							type: "toolCall",
							id: "call_2",
							name: "write_file",
							arguments: {
								Path: path.join(tempDir, "docs", "new.md"),
								Content: "# New Document\nAdded content.\n",
							},
						},
					],
				},
			},
		];

		await fs.writeFile(sessionFile, sessionEntries.map(e => JSON.stringify(e)).join("\n"), "utf8");

		const patches = await extractSessionPatches(sessionFile, tempDir);
		expect(patches.length).toBe(2);

		const samplePatch = patches.find(p => p.filePath === targetFile);
		expect(samplePatch).toBeDefined();
		expect(samplePatch?.newContent).toContain('console.log("hello world");');
		expect(samplePatch?.insertions).toBeGreaterThan(0);

		const newDocPatch = patches.find(p => p.relativePath === path.join("docs", "new.md"));
		expect(newDocPatch).toBeDefined();
		expect(newDocPatch?.newContent).toContain("# New Document");
	});

	it("performs dry run without modifying files", async () => {
		const targetFile = path.join(tempDir, "dry.txt");
		await fs.writeFile(targetFile, "original line\n", "utf8");

		const sessionFile = path.join(tempDir, "dry-session.jsonl");
		const sessionEntries = [
			{ type: "session", id: "sess_dry", timestamp: Date.now(), cwd: tempDir },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_dry",
							name: "write_file",
							arguments: {
								Path: targetFile,
								Content: "modified line\n",
							},
						},
					],
				},
			},
		];
		await fs.writeFile(sessionFile, sessionEntries.map(e => JSON.stringify(e)).join("\n"), "utf8");

		const logs: string[] = [];
		const result = await runApplyCommand({
			target: sessionFile,
			dryRun: true,
			cwd: tempDir,
			stdout: msg => logs.push(msg),
		});

		expect(result.dryRun).toBe(true);
		expect(result.patches.length).toBe(1);

		// Disk content must remain unchanged
		const currentContent = await fs.readFile(targetFile, "utf8");
		expect(currentContent).toBe("original line\n");
		expect(logs.some(l => l.includes("[dry-run]"))).toBe(true);
	});

	it("applies modifications cleanly to disk", async () => {
		const targetFile = path.join(tempDir, "apply.txt");
		await fs.writeFile(targetFile, "before edit\n", "utf8");

		const sessionFile = path.join(tempDir, "apply-session.jsonl");
		const sessionEntries = [
			{ type: "session", id: "sess_real", timestamp: Date.now(), cwd: tempDir },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_real",
							name: "write_file",
							arguments: {
								Path: targetFile,
								Content: "after edit\n",
							},
						},
					],
				},
			},
		];
		await fs.writeFile(sessionFile, sessionEntries.map(e => JSON.stringify(e)).join("\n"), "utf8");

		const logs: string[] = [];
		const result = await runApplyCommand({
			target: sessionFile,
			dryRun: false,
			cwd: tempDir,
			stdout: msg => logs.push(msg),
		});

		expect(result.dryRun).toBe(false);
		expect(result.patches.length).toBe(1);

		const updatedContent = await fs.readFile(targetFile, "utf8");
		expect(updatedContent).toBe("after edit\n");
		expect(logs.some(l => l.includes("Successfully applied"))).toBe(true);
	});
});
