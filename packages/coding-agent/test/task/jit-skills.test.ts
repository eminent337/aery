import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../../src/sdk";
import { filterSkillsJIT, getFileExtensions } from "../../src/task/jit-skills";

describe("JIT Skill Resolver", () => {
	const mockSkills: Skill[] = [
		{ name: "generic-helper", description: "Generic instructions" } as any,
		{ name: "TypeScript-TDD", description: "TypeScript TDD guidelines" } as any,
		{ name: "Rust-Cargo-Verification", description: "Rust compilation checklist" } as any,
	];

	it("filters to typescript matching skills when ts is present", () => {
		const filtered = filterSkillsJIT(mockSkills, ["ts"]);
		expect(filtered.map(s => s.name)).toEqual(["generic-helper", "TypeScript-TDD"]);
	});

	it("filters to rust matching skills when rs is present", () => {
		const filtered = filterSkillsJIT(mockSkills, ["rs"]);
		expect(filtered.map(s => s.name)).toEqual(["generic-helper", "Rust-Cargo-Verification"]);
	});

	it("returns all skills if no matching extensions are found", () => {
		const filtered = filterSkillsJIT(mockSkills, ["cpp"]);
		expect(filtered).toEqual(mockSkills);
	});

	it("extracts extensions from directory structure correctly", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jit-skills-test-"));
		try {
			await fs.writeFile(path.join(tmpDir, "file1.ts"), "");
			await fs.writeFile(path.join(tmpDir, "file2.JS"), "");

			const subDir = path.join(tmpDir, "src");
			await fs.mkdir(subDir);
			await fs.writeFile(path.join(subDir, "file3.py"), "");

			// Ignored directory
			const nodeModules = path.join(tmpDir, "node_modules");
			await fs.mkdir(nodeModules);
			await fs.writeFile(path.join(nodeModules, "file4.rs"), "");

			const exts = await getFileExtensions(tmpDir);
			expect(exts.sort()).toEqual(["JS", "py", "ts"]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
