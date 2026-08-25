import { spawn } from "node:child_process";
import { ENDORSED_SKILLS } from "../../../skills/endorsed-catalog";
import type { SkillItem, SkillTabId } from "./types";

export class SkillsStateManager {
	constructor(
		private readonly cwd: string,
		private readonly installedSkills: readonly { name: string; description?: string; filePath?: string }[] = [],
	) {}

	async loadSkills(): Promise<SkillItem[]> {
		const installedMap = new Map(
			this.installedSkills.map(s => [s.name, s]),
		);

		const items: SkillItem[] = [];
		const seenNames = new Set<string>();

		// 1. Endorsed catalog skills
		for (const endorsed of ENDORSED_SKILLS) {
			const isInst = installedMap.has(endorsed.name);
			const installedSkill = installedMap.get(endorsed.name);
			items.push({
				name: endorsed.name,
				description: endorsed.description,
				category: endorsed.category,
				source: endorsed.source,
				installCmd: endorsed.install,
				installed: isInst,
				filePath: installedSkill?.filePath,
			});
			seenNames.add(endorsed.name);
		}

		// 2. Any additional installed skills not in endorsed catalog
		for (const installed of this.installedSkills) {
			if (!seenNames.has(installed.name)) {
				items.push({
					name: installed.name,
					description: installed.description ?? "Local workspace skill",
					category: "Custom",
					source: installed.filePath ?? "local",
					installCmd: null,
					installed: true,
					filePath: installed.filePath,
				});
				seenNames.add(installed.name);
			}
		}

		return items;
	}

	filterSkills(items: SkillItem[], tab: SkillTabId, query: string): SkillItem[] {
		const lowerQuery = query.trim().toLowerCase();

		return items.filter(item => {
			if (tab === "installed" && !item.installed) return false;

			if (!lowerQuery) return true;
			const matchName = item.name.toLowerCase().includes(lowerQuery);
			const matchDesc = item.description.toLowerCase().includes(lowerQuery);
			const matchCat = item.category.toLowerCase().includes(lowerQuery);

			return matchName || matchDesc || matchCat;
		});
	}

	async installSkill(skill: SkillItem): Promise<{ ok: boolean; message: string }> {
		if (!skill.installCmd) {
			return { ok: false, message: `Skill ${skill.name} is bundled or cannot be installed via npx.` };
		}

		const isWindows = process.platform === "win32";
		return new Promise(resolve => {
			const child = spawn("npx", skill.installCmd!.split(" ").slice(1), {
				cwd: this.cwd,
				stdio: "pipe",
				env: process.env,
				windowsHide: true,
				...(isWindows ? { shell: true } : {}),
			});

			let output = "";
			let errOutput = "";

			child.stdout?.on("data", (d: Buffer) => {
				output += d.toString();
			});

			child.stderr?.on("data", (d: Buffer) => {
				errOutput += d.toString();
			});

			child.once("close", code => {
				if (code === 0) {
					resolve({ ok: true, message: `Successfully installed skill: ${skill.name}` });
				} else {
					resolve({
						ok: false,
						message: `Failed to install skill (${code}): ${errOutput.trim() || output.trim()}`,
					});
				}
			});

			child.once("error", err => {
				resolve({ ok: false, message: `Error running install: ${err.message}` });
			});
		});
	}
}
