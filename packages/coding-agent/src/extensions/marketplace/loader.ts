/**
 * Marketplace Loader Extension
 *
 * At session_start, reads ~/.aery/agent/settings.json and loads
 * any extensions the user installed via `/marketplace install`.
 * Extensions live in ~/.aery/agent/git/github.com/<source>/<file>.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";

const SETTINGS_PATH = join(homedir(), ".aery", "agent", "settings.json");
const GIT_BASE = join(homedir(), ".aery", "agent", "git", "github.com");

interface AerySettings {
	extensions?: string[];
	packages?: string[];
}

function loadSettings(): AerySettings {
	if (!existsSync(SETTINGS_PATH)) return {};
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as AerySettings;
	} catch {
		return {};
	}
}

export default function createMarketplaceLoaderExtension(api: ExtensionAPI): void {
	api.on("session_start", async () => {
		const settings = loadSettings();

		// Load individual extension files (e.g. "eminent337/aery-extensions/core/graphify.ts")
		if (settings.extensions && settings.extensions.length > 0) {
			for (const extPath of settings.extensions) {
				try {
					const resolved = join(GIT_BASE, extPath);
					if (!existsSync(resolved)) {
						api.logger.warn(`Marketplace: extension file not found: ${resolved}`);
						continue;
					}
					// Dynamic import: plugin loading from a runtime registry — paths come from settings.json
					const mod = await import(resolved);
					if (typeof mod.default === "function") {
						mod.default(api);
						api.logger.info(`Marketplace: loaded extension ${extPath}`);
					}
				} catch (err) {
					api.logger.warn(`Marketplace: failed to load ${extPath}`, { error: String(err) });
				}
			}
		}

		// Load packages (whole repos with an index.ts entry point)
		if (settings.packages && settings.packages.length > 0) {
			for (const repoUrl of settings.packages) {
				try {
					const match = repoUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
					if (!match) continue;
					const repoPath = join(GIT_BASE, match[1], "index.ts");
					if (!existsSync(repoPath)) {
						api.logger.warn(`Marketplace: package entry not found: ${repoPath}`);
						continue;
					}
					// Dynamic import: plugin loading from a runtime registry — paths come from settings.json
					const mod = await import(repoPath);
					if (typeof mod.default === "function") {
						mod.default(api);
						api.logger.info(`Marketplace: loaded package ${match[1]}`);
					}
				} catch (err) {
					api.logger.warn(`Marketplace: failed to load package`, { error: String(err) });
				}
			}
		}
	});
}
