import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@aryee337/aery-utils";

export interface ProjectMemory {
	filePath: string;
	content: string;
	facts: string[];
}

export function getProjectMemoryPath(cwd = process.cwd()): string {
	return path.join(cwd, "MEMORY.md");
}

export function getProjectMemoryDir(cwd = process.cwd()): string {
	return path.join(cwd, ".aery", "agent-memory");
}

export async function loadProjectMemory(cwd = process.cwd()): Promise<ProjectMemory | null> {
	const primaryPath = getProjectMemoryPath(cwd);
	const fallbackPath = path.join(getProjectMemoryDir(cwd), "index.md");

	let filePath = primaryPath;
	let content = "";

	try {
		content = await fs.readFile(primaryPath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) {
			try {
				content = await fs.readFile(fallbackPath, "utf-8");
				filePath = fallbackPath;
			} catch {
				return null;
			}
		} else {
			return null;
		}
	}

	const facts = content
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.startsWith("- ") || l.startsWith("* "))
		.map(l => l.replace(/^[-*]\s+/, ""));

	return {
		filePath,
		content,
		facts,
	};
}

export async function saveProjectMemory(content: string, cwd = process.cwd()): Promise<string> {
	const filePath = getProjectMemoryPath(cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
	return filePath;
}

export async function appendProjectMemory(fact: string, cwd = process.cwd()): Promise<string> {
	const trimmed = fact.trim();
	if (!trimmed) return getProjectMemoryPath(cwd);

	const existing = await loadProjectMemory(cwd);
	let newContent = "";
	if (existing && existing.content.trim().length > 0) {
		newContent = `${existing.content.trimEnd()}\n- ${trimmed}\n`;
	} else {
		newContent = `# Project Memory\n\n- ${trimmed}\n`;
	}

	return await saveProjectMemory(newContent, cwd);
}
