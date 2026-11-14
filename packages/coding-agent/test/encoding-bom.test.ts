import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { EditFileTool } from "../src/tools/edit-file";
import { ReadFileTool } from "../src/tools/read-file";
import { WriteFileTool } from "../src/tools/write-file";

describe("Encoding and BOM Preservation (AGY 1.5.3 Parity)", () => {
	let tempDir: string;
	const mockSession = { cwd: "", settings: Settings.isolated() } as any;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `aery-bom-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		await fs.mkdir(tempDir, { recursive: true });
		mockSession.cwd = tempDir;
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("preserves UTF-8 BOM on edit_file operations", async () => {
		const filePath = path.join(tempDir, "bom-doc.txt");
		const originalText = "\uFEFFinitial content line 1\nline 2\n";
		await fs.writeFile(filePath, originalText, "utf8");

		const editTool = new EditFileTool(mockSession);
		await editTool.execute("edit_1", {
			Path: filePath,
			Target: "line 2",
			Replacement: "modified line 2",
		});

		const rawBuf = await fs.readFile(filePath);
		expect(rawBuf[0]).toBe(0xef);
		expect(rawBuf[1]).toBe(0xbb);
		expect(rawBuf[2]).toBe(0xbf);

		const updatedText = await fs.readFile(filePath, "utf8");
		expect(updatedText).toContain("modified line 2");
	});

	it("adds UTF-8 BOM to PowerShell scripts with non-ASCII text on write and edit", async () => {
		const psFile = path.join(tempDir, "script.ps1");
		const nonAsciiContent = 'Write-Output "Héllo Wörld"';

		const writeTool = new WriteFileTool(mockSession);
		await writeTool.execute("write_ps", {
			Path: psFile,
			Content: nonAsciiContent,
		});

		const rawBuf = await fs.readFile(psFile);
		expect(rawBuf[0]).toBe(0xef);
		expect(rawBuf[1]).toBe(0xbb);
		expect(rawBuf[2]).toBe(0xbf);

		const editTool = new EditFileTool(mockSession);
		await editTool.execute("edit_ps", {
			Path: psFile,
			Target: "Wörld",
			Replacement: "Unîcøde",
		});

		const updatedBuf = await fs.readFile(psFile);
		expect(updatedBuf[0]).toBe(0xef);
		expect(updatedBuf[1]).toBe(0xbb);
		expect(updatedBuf[2]).toBe(0xbf);
	});

	it("reads and decodes UTF-16 files cleanly", async () => {
		const utf16File = path.join(tempDir, "utf16.txt");
		const contentStr = "First Line\nSecond Line\n";
		const utf16leBuf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(contentStr, "utf16le")]);
		await fs.writeFile(utf16File, utf16leBuf);

		const readTool = new ReadFileTool(mockSession);
		const result = await readTool.execute("read_utf16", {
			Path: utf16File,
		});

		expect(result.content[0].text).toContain("First Line");
		expect(result.content[0].text).toContain("Second Line");
	});
});
