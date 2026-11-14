import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runImport, scanForeignAgentConfigs } from "../src/cli/import-cli";

describe("Foreign Agent Importer CLI", () => {
	it("should detect and import .cursorrules, CLAUDE.md, and codex.md", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-test-"));
		try {
			// Write sample configs
			await fs.writeFile(path.join(tempDir, ".cursorrules"), "You are a senior engineer.", "utf-8");
			await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "# Claude guidelines\nAlways test before committing.", "utf-8");
			await fs.writeFile(path.join(tempDir, "codex.md"), "Follow strict formatting rules.", "utf-8");

			const items = await scanForeignAgentConfigs(tempDir);
			expect(items.length).toBe(3);

			const names = items.map(i => i.name);
			expect(names.some(n => n.includes("Cursor"))).toBe(true);
			expect(names.some(n => n.includes("Claude"))).toBe(true);
			expect(names.some(n => n.includes("Codex"))).toBe(true);

			// Test dry-run
			const dryResult = await runImport({ targetDir: tempDir, dryRun: true });
			expect(dryResult.dryRun).toBe(true);
			expect(dryResult.foundItems.length).toBe(3);
			expect(dryResult.importedCount).toBe(0);

			// Test actual import
			const result = await runImport({ targetDir: tempDir, dryRun: false });
			expect(result.importedCount).toBe(3);

			// Verify imported files exist under .aery/rules/
			const cursorRule = await fs.readFile(path.join(tempDir, ".aery", "rules", "cursor-imported.md"), "utf-8");
			expect(cursorRule).toContain("senior engineer");

			const claudeRule = await fs.readFile(path.join(tempDir, ".aery", "rules", "claude-imported.md"), "utf-8");
			expect(claudeRule).toContain("Claude guidelines");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
