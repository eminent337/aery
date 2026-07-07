import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill } from "../sdk"; // Adjust import path if needed

const EXTENSION_MAP: Record<string, string[]> = {
	ts: ["typescript", "ts-edit"],
	js: ["javascript"],
	rs: ["rust", "cargo"],
	py: ["python"],
};

export function filterSkillsJIT(skills: Skill[], fileExtensions: string[]): Skill[] {
	const activeKeywords = new Set<string>();
	for (const ext of fileExtensions) {
		const keywords = EXTENSION_MAP[ext.toLowerCase()];
		if (keywords) {
			for (const kw of keywords) activeKeywords.add(kw);
		}
	}

	if (activeKeywords.size === 0) {
		return skills; // Fall back to all if no specific extensions match
	}

	return skills.filter(skill => {
		const lowerName = skill.name.toLowerCase();
		// Keep essential/generic skills, or skills matching the keywords
		return (
			lowerName.includes("essential") ||
			lowerName.includes("generic") ||
			Array.from(activeKeywords).some(kw => lowerName.includes(kw))
		);
	});
}

export async function getFileExtensions(dir: string): Promise<string[]> {
	const extensions = new Set<string>();
	const ignoredDirs = new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		".aery",
		"venv",
		".venv",
		"__pycache__",
		"target",
		".cargo",
		"out",
		".next",
		".nuxt",
	]);

	async function walk(currentDir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(currentDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (ignoredDirs.has(entry.name)) continue;
				await walk(path.join(currentDir, entry.name));
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name);
				if (ext) {
					extensions.add(ext.slice(1));
				}
			}
		}
	}

	await walk(dir);
	return Array.from(extensions);
}
