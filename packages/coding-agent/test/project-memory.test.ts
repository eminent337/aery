import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendProjectMemory, loadProjectMemory, saveProjectMemory } from "../src/memory/project-memory";

describe("Project Persistent Memory", () => {
	it("should load, save, and append facts to MEMORY.md", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
		try {
			const initial = await loadProjectMemory(tempDir);
			expect(initial).toBeNull();

			await saveProjectMemory("# Project Memory\n\n- The app uses PostgreSQL for storage\n", tempDir);
			const loaded = await loadProjectMemory(tempDir);
			expect(loaded).toBeDefined();
			expect(loaded?.facts.length).toBe(1);
			expect(loaded?.facts[0]).toContain("PostgreSQL");

			await appendProjectMemory("Redis is used for caching session tokens", tempDir);
			const updated = await loadProjectMemory(tempDir);
			expect(updated?.facts.length).toBe(2);
			expect(updated?.facts[1]).toContain("Redis");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
