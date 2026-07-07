import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill } from "../sdk"; // Adjust import path if needed

const EXTENSION_KEYWORDS: Record<string, string[]> = {
	ts: ["typescript", "ts-edit", "ts", "tsx"],
	js: ["javascript", "js", "jsx"],
	rs: ["rust", "cargo", "rs"],
	py: ["python", "py"],
};

/**
 * Match a language keyword against a skill name using word boundaries so that
 * substring collisions don't misclassify skills. e.g. "trust-issues" must NOT
 * match "rust", and "cargobay" must NOT match "cargo". We treat a keyword as a
 * match only when it appears as a standalone token (preceded/followed by a
 * non-alphanumeric boundary or string edge).
 */
function nameMatchesKeyword(lowerName: string, keyword: string): boolean {
	const re = new RegExp(`(^|[^a-z0-9])${keyword}([^a-z0-9]|$)`, "i");
	return re.test(lowerName);
}

export function filterSkillsJIT(skills: Skill[], fileExtensions: string[]): Skill[] {
	if (fileExtensions.length === 0) {
		return skills; // Fall back to all if no extensions at all are found (e.g. empty directory)
	}

	const workspaceExtensions = new Set(fileExtensions.map(ext => ext.toLowerCase()));

	return skills.filter(skill => {
		const lowerName = skill.name.toLowerCase();

		let isLanguageSpecific = false;
		let isLanguagePresent = false;

		for (const [ext, keywords] of Object.entries(EXTENSION_KEYWORDS)) {
			const matchesKeywords = keywords.some(kw => nameMatchesKeyword(lowerName, kw));
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
