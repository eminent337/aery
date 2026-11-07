import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SkillHubClient } from "../src/skills/hub";

describe("SkillHubClient", () => {
	let tempDir: string;
	let skillsDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-hub-test-"));
		skillsDir = path.join(tempDir, "skills");
		await fs.mkdir(skillsDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("parses local catalog index and checks installed status", async () => {
		const client = new SkillHubClient({
			skillsDir,
			catalogPath: "/home/aryee/aery/aery-skills/skills.json",
			hubRepoRoot: "/home/aryee/aery/aery-skills",
		});

		const catalog = await client.getCatalog();
		expect(catalog.skills.length).toBeGreaterThan(0);
		const humanizer = catalog.skills.find(s => s.name === "ai-humanizer");
		expect(humanizer).toBeDefined();
		expect(humanizer?.installed).toBe(false);
	});

	it("installs a skill from local repo to target skillsDir and preserves executable flags", async () => {
		const client = new SkillHubClient({
			skillsDir,
			catalogPath: "/home/aryee/aery/aery-skills/skills.json",
			hubRepoRoot: "/home/aryee/aery/aery-skills",
		});

		const result = await client.install("ai-humanizer");
		expect(result.success).toBe(true);

		const installedSkillFile = path.join(skillsDir, "ai-humanizer", "SKILL.md");
		const exists = await fs.exists(installedSkillFile);
		expect(exists).toBe(true);

		const scriptFile = path.join(skillsDir, "ai-humanizer", "scripts", "ai-humanizer");
		const stat = await fs.stat(scriptFile);
		// Check executable flag
		expect((stat.mode & 0o111) !== 0).toBe(true);

		// Now check installed status in catalog
		const catalog = await client.getCatalog();
		const humanizer = catalog.skills.find(s => s.name === "ai-humanizer");
		expect(humanizer?.installed).toBe(true);
	});

	it("uninstalls an installed skill cleanly", async () => {
		const client = new SkillHubClient({
			skillsDir,
			catalogPath: "/home/aryee/aery/aery-skills/skills.json",
			hubRepoRoot: "/home/aryee/aery/aery-skills",
		});

		await client.install("ai-humanizer");
		const uninstalled = await client.uninstall("ai-humanizer");
		expect(uninstalled.success).toBe(true);

		const exists = await fs.exists(path.join(skillsDir, "ai-humanizer"));
		expect(exists).toBe(false);
	});
});
