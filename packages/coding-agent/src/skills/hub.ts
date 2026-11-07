/**
 * Aery Skill Hub Client
 *
 * Provides on-demand skill catalog discovery, installation, and uninstallation
 * from the Aery Skill Hub registry without bundling skills into the core binary.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir } from "@aryee337/aery-utils";

export interface SkillHubEntry {
	name: string;
	version: string;
	description: string;
	category: string;
	author?: string;
	path: string;
	entry?: string;
	scripts?: string[];
	installed?: boolean;
	filePath?: string;
}

export interface SkillHubManifest {
	name: string;
	version: string;
	description: string;
	repository: string;
	skills: SkillHubEntry[];
}

export interface SkillHubClientOptions {
	/** Directory where skills are installed (defaults to ~/.aery/skills) */
	skillsDir?: string;
	/** Direct catalog file path (for local/testing or offline fallback) */
	catalogPath?: string;
	/** Local hub repository root (for local resolution) */
	hubRepoRoot?: string;
	/** Remote catalog URL (defaults to GitHub raw) */
	remoteUrl?: string;
}

export interface InstallResult {
	success: boolean;
	message: string;
	installedPath?: string;
}

const DEFAULT_HUB_URL = "https://raw.githubusercontent.com/eminent337/aery-skills/main/skills.json";

export class SkillHubClient {
	private readonly skillsDir: string;
	private readonly catalogPath?: string;
	private readonly hubRepoRoot?: string;
	private readonly remoteUrl: string;

	constructor(options: SkillHubClientOptions = {}) {
		this.skillsDir = options.skillsDir || path.join(os.homedir(), ".aery", "skills");
		this.catalogPath = options.catalogPath;
		this.hubRepoRoot = options.hubRepoRoot;
		this.remoteUrl = options.remoteUrl || DEFAULT_HUB_URL;
	}

	/**
	 * Get the full catalog of available skills with installed status.
	 */
	async getCatalog(): Promise<SkillHubManifest> {
		let manifest: SkillHubManifest | null = null;

		// 1. Check local catalog path if specified
		if (this.catalogPath) {
			try {
				const content = await fs.readFile(this.catalogPath, "utf-8");
				manifest = JSON.parse(content);
			} catch {
				// fallback
			}
		}

		// 2. Fallback to local default /home/aryee/aery/aery-skills/skills.json if present
		if (!manifest) {
			const fallbackLocal = path.join(os.homedir(), "aery", "aery-skills", "skills.json");
			try {
				const content = await fs.readFile(fallbackLocal, "utf-8");
				manifest = JSON.parse(content);
			} catch {
				// fallback
			}
		}

		// 3. Fallback to cache or remote fetch
		if (!manifest) {
			const cacheFile = path.join(this.skillsDir, ".hub-cache.json");
			try {
				const resp = await fetch(this.remoteUrl, { signal: AbortSignal.timeout(3000) });
				if (resp.ok) {
					manifest = (await resp.json()) as SkillHubManifest;
					await fs.mkdir(this.skillsDir, { recursive: true });
					await fs.writeFile(cacheFile, JSON.stringify(manifest, null, 2), "utf-8");
				}
			} catch {
				// try reading cache
				try {
					const cached = await fs.readFile(cacheFile, "utf-8");
					manifest = JSON.parse(cached) as SkillHubManifest;
				} catch {
					// fallback empty
				}
			}
		}

		if (!manifest) {
			manifest = {
				name: "aery-skills",
				version: "1.0.0",
				description: "Aery Skill Hub",
				repository: "https://github.com/eminent337/aery-skills",
				skills: [],
			};
		}

		// Decorate entries with installed status
		for (const skill of manifest.skills) {
			const skillTargetDir = path.join(this.skillsDir, skill.name);
			const skillFile = path.join(skillTargetDir, skill.entry || "SKILL.md");
			try {
				await fs.access(skillFile);
				skill.installed = true;
				skill.filePath = skillFile;
			} catch {
				skill.installed = false;
			}
		}

		return manifest;
	}

	/**
	 * Install a skill from the hub into the target skillsDir.
	 */
	async install(skillName: string): Promise<InstallResult> {
		const catalog = await this.getCatalog();
		const entry = catalog.skills.find(s => s.name === skillName);
		if (!entry) {
			return {
				success: false,
				message: `Skill "${skillName}" not found in Aery Skill Hub.`,
			};
		}

		const targetDir = path.join(this.skillsDir, entry.name);
		await fs.mkdir(targetDir, { recursive: true });

		// Source resolution: local repo root first if available
		const localBase = this.hubRepoRoot || path.join(os.homedir(), "aery", "aery-skills");
		const sourceDir = path.join(localBase, entry.path);

		try {
			await fs.access(sourceDir);
			await this.copyDirRecursive(sourceDir, targetDir);

			// Ensure scripts have executable permissions
			if (entry.scripts) {
				for (const scriptRel of entry.scripts) {
					const scriptPath = path.join(targetDir, scriptRel);
					try {
						await fs.chmod(scriptPath, 0o755);
					} catch {
						// ignore if missing
					}
				}
			}

			return {
				success: true,
				message: `Successfully installed skill "${entry.name}" v${entry.version} into ${targetDir}`,
				installedPath: targetDir,
			};
		} catch (err: any) {
			// Remote clone / download fallback could be plugged here
			return {
				success: false,
				message: `Failed to install skill "${entry.name}": ${err.message}`,
			};
		}
	}

	/**
	 * Uninstall an installed skill.
	 */
	async uninstall(skillName: string): Promise<InstallResult> {
		const targetDir = path.join(this.skillsDir, skillName);
		try {
			await fs.access(targetDir);
			await fs.rm(targetDir, { recursive: true, force: true });
			return {
				success: true,
				message: `Successfully uninstalled skill "${skillName}"`,
			};
		} catch (err: any) {
			return {
				success: false,
				message: `Skill "${skillName}" is not installed: ${err.message}`,
			};
		}
	}

	private async copyDirRecursive(src: string, dest: string): Promise<void> {
		await fs.mkdir(dest, { recursive: true });
		const entries = await fs.readdir(src, { withFileTypes: true });

		for (const entry of entries) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);

			if (entry.isDirectory()) {
				await this.copyDirRecursive(srcPath, destPath);
			} else if (entry.isFile()) {
				await fs.copyFile(srcPath, destPath);
				const stat = await fs.stat(srcPath);
				await fs.chmod(destPath, stat.mode);
			}
		}
	}
}

/** Global singleton helper for standard Aery runtime operations */
let defaultHubClient: SkillHubClient | null = null;

export function getSkillHubClient(): SkillHubClient {
	if (!defaultHubClient) {
		defaultHubClient = new SkillHubClient();
	}
	return defaultHubClient;
}
