import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@aryee337/aery-utils";
import type { Skill } from "../extensibility/skills";

export async function loadAerySkills(): Promise<Skill[]> {
	const skillsDir = path.join(os.homedir(), ".aery", "skills");
	const skills: Skill[] = [];

	try {
		const stat = await fs.stat(skillsDir);
		if (!stat.isDirectory()) {
			return skills;
		}
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return skills;
		}
		throw err;
	}

	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await fs.readdir(skillsDir, { withFileTypes: true });
	} catch (err: any) {
		logger.warn(`Failed to read aery skills directory ${skillsDir}`, { error: String(err) });
		return skills;
	}

	for (const entry of entries) {
		if (entry.isDirectory()) {
			const skillDir = path.join(skillsDir, entry.name);
			const mdPath = path.join(skillDir, "SKILL.md");
			const jsonPath = path.join(skillDir, "skill.json");

			try {
				let description = "";
				let filePath = "";

				// Try SKILL.md first
				try {
					const mdContent = await fs.readFile(mdPath, "utf8");
					filePath = mdPath;
					// Basic frontmatter parsing for description if any
					const descriptionMatch = mdContent.match(/^description:\s*(.*)/im);
					if (descriptionMatch) {
						description = descriptionMatch[1].trim();
					}
				} catch (e: any) {
					if (e.code !== "ENOENT") throw e;

					// Fallback to skill.json
					const jsonContent = await fs.readFile(jsonPath, "utf8");
					filePath = jsonPath;
					const parsed = JSON.parse(jsonContent);
					if (parsed.description) {
						description = parsed.description;
					}
				}

				if (filePath) {
					skills.push({
						name: entry.name,
						description,
						filePath,
						baseDir: skillDir,
						source: "aery:user",
					});
				}
			} catch (e: any) {
				if (e.code !== "ENOENT") {
					logger.warn(`Failed to load aery skill from ${skillDir}`, { error: String(e) });
				}
			}
		}
	}

	return skills;
}
