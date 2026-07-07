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
	if (fileExtensions.length === 0) {
		return skills; // Fall back to all if no extensions at all are found (e.g. empty directory)
	}

	const workspaceExtensions = new Set(fileExtensions.map(ext => ext.toLowerCase()));

	return skills.filter(skill => {
		const lowerName = skill.name.toLowerCase();

		let isLanguageSpecific = false;
		let isLanguagePresent = false;

		for (const [ext, keywords] of Object.entries(EXTENSION_MAP)) {
			const matchesKeywords = keywords.some(kw => lowerName.includes(kw));
			if (matchesKeywords) {
				isLanguageSpecific = true;
				if (workspaceExtensions.has(ext)) {
					isLanguagePresent = true;
				}
			}
		}

		if (!isLanguageSpecific) {
			return true;
		}
		return isLanguagePresent;
	});
}

const MAX_DEPTH = 3;
const MAX_FILES = 1000;

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

	let fileCount = 0;
	let stopWalking = false;

	async function walk(currentDir: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH || stopWalking) return;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(currentDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (stopWalking) return;
			if (entry.isDirectory()) {
				if (ignoredDirs.has(entry.name)) continue;
				await walk(path.join(currentDir, entry.name), depth + 1);
			} else if (entry.isFile()) {
				fileCount++;
				if (fileCount > MAX_FILES) {
					stopWalking = true;
					return;
				}
				const ext = path.extname(entry.name);
				if (ext) {
					extensions.add(ext.slice(1));
				}
			}
		}
	}

	await walk(dir, 0);
	return Array.from(extensions);
}
