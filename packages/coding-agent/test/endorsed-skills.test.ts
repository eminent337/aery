import { describe, expect, it } from "bun:test";
import {
	ENDORSED_SKILL_CATEGORIES,
	ENDORSED_SKILLS,
	type EndorsedSkill,
	installedEndorsedSkillNames,
	renderEndorsedSkills,
} from "@aryee337/aery/skills/endorsed-catalog";

describe("endorsed skills catalog", () => {
	it("contains the bundled optimization skill as an Aery-category entry", () => {
		const optimization = ENDORSED_SKILLS.find(skill => skill.name === "optimization");
		expect(optimization).toBeDefined();
		expect(optimization?.category).toBe("Aery");
		expect(optimization?.install).toBeNull();
	});

	it("has unique skill names", () => {
		const names = new Set(ENDORSED_SKILLS.map(skill => skill.name));
		expect(names.size).toBe(ENDORSED_SKILLS.length);
	});

	it("every entry has a name, description, category, and source", () => {
		for (const skill of ENDORSED_SKILLS) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.category.length).toBeGreaterThan(0);
			expect(skill.source.length).toBeGreaterThan(0);
			expect(skill.install === null || typeof skill.install === "string").toBe(true);
		}
	});

	it("categories cover every endorsed skill", () => {
		for (const skill of ENDORSED_SKILLS) {
			expect(ENDORSED_SKILL_CATEGORIES).toContain(skill.category);
		}
	});

	it("renderEndorsedSkills marks installed entries and groups by category", () => {
		const installed = new Set<string>(["optimization", "frontend-design"]);
		const output = renderEndorsedSkills(installed);

		expect(output).toContain("# Aery");
		expect(output).toContain("# Anthropic Design");
		expect(output).toContain("# NVIDIA CUDA-X");
		expect(output).toContain("[installed] optimization");
		expect(output).toContain("[installed] frontend-design");
		expect(output).toContain("[missing] cuopt-developer");
	});

	it("installedEndorsedSkillNames only returns endorsed names that are installed", () => {
		const installed = new Set<string>(["optimization", "not-an-endorsed-skill", "cupynumeric-install"]);
		const endorsed = installedEndorsedSkillNames(installed);
		expect(endorsed.has("optimization")).toBe(true);
		expect(endorsed.has("cupynumeric-install")).toBe(true);
		expect(endorsed.has("not-an-endorsed-skill")).toBe(false);
		expect(endorsed.size).toBe(2);
	});

	it("is a small static record-friendly table (no runtime key growth)", () => {
		const byName: Record<string, EndorsedSkill> = {};
		for (const skill of ENDORSED_SKILLS) {
			byName[skill.name] = skill;
		}
		const entries = Object.entries(byName);
		expect(entries.length).toBe(ENDORSED_SKILLS.length);
		expect(byName["cudaq-guide"]?.category).toBe("NVIDIA CUDA-X");
	});
});
