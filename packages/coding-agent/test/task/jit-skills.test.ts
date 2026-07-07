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

	it("filters to typescript matching skills when ts is present, keeping generic skills", () => {
		const filtered = filterSkillsJIT(mockSkills, ["ts"]);
		expect(filtered.map(s => s.name)).toEqual(["generic-helper", "TypeScript-TDD"]);
	});

	it("filters to rust matching skills when rs is present, keeping generic skills", () => {
		const filtered = filterSkillsJIT(mockSkills, ["rs"]);
		expect(filtered.map(s => s.name)).toEqual(["generic-helper", "Rust-Cargo-Verification"]);
	});

	it("filters out language-specific skills when only unrelated extensions are found", () => {
		const filtered = filterSkillsJIT(mockSkills, ["cpp"]);
		expect(filtered.map(s => s.name)).toEqual(["generic-helper"]);
	});

	it("returns all skills if extensions list is empty (fallback)", () => {
		const filtered = filterSkillsJIT(mockSkills, []);
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

describe("JIT Skill Resolver — lossy-detection edge cases", () => {
	const mockSkills: Skill[] = [
		{ name: "trust-issues", description: "A skill about trust" } as any,
		{ name: "cargobay-loader", description: "Cargo bay loader doc" } as any,
		{ name: "antitypescript-notes", description: "Notes" } as any,
		{ name: "rusty-process", description: "A process that is rusty" } as any,
		{ name: "Rust-Style-Guide", description: "Rust conventions" } as any,
		{ name: "generic-helper", description: "Generic instructions" } as any,
	];

	it("does NOT wrongly exclude general skills whose name contains a language substring", () => {
		// No .rs / .ts / .js / .py present -> language skills dropped, but the
		// general-looking ones (trust-issues, cargobay-loader, antitypescript-notes,
		// rusty-process) must NOT be treated as language-specific and dropped.
		const filtered = filterSkillsJIT(mockSkills, ["cpp"]);
		const names = filtered.map(s => s.name);
		expect(names).toContain("trust-issues");
		expect(names).toContain("cargobay-loader");
		expect(names).toContain("antitypescript-notes");
		expect(names).toContain("rusty-process");
		expect(names).toContain("generic-helper");
		// Only the genuinely rust-specific skill is dropped when no .rs exists.
		expect(names).not.toContain("Rust-Style-Guide");
	});

	it("keeps a genuinely rust-specific skill when .rs is present", () => {
		const filtered = filterSkillsJIT(mockSkills, ["rs"]);
		const names = filtered.map(s => s.name);
		expect(names).toContain("Rust-Style-Guide");
		expect(names).toContain("generic-helper");
		// The false-positive-prone names are NOT language-specific, so they stay.
		expect(names).toContain("trust-issues");
		expect(names).toContain("rusty-process");
	});

	it("keeps skills whose name only contains a language substring, but drops real language skills", () => {
		// rusty-process contains 'rust' as a SUBSTRING (rust + y), not as a
		// standalone token, so it is NOT treated as a rust-specific skill and is
		// kept even when no .rs extension is present.
		const filtered = filterSkillsJIT(mockSkills, ["py"]);
		const names = filtered.map(s => s.name);
		expect(names).toContain("rusty-process");
		expect(names).not.toContain("Rust-Style-Guide");
		expect(names).toContain("generic-helper");
		expect(names).toContain("trust-issues");
	});
});
