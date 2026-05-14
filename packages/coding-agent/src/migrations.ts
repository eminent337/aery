/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.js";
import { migrateKeybindingsConfig } from "./core/keybindings.js";

const MIGRATION_GUIDE_URL =
	"https://github.com/eminent337/aery/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL = "https://github.com/eminent337/aery/blob/main/packages/coding-agent/docs/extensions.md";
export const CORE_EXTENSION_PATHS = [
	"damage-control",
	"model-failover",
	"web-search",
	"web-fetch",
	"commands",
	"hooks",
	"circuit-breaker",
	"auto-router",
	"memory-include",
	"aery-header",
	"aery-footer",
	"multi-agent",
	"agent-chain",
	"agent-teams",
	"help",
	"default-agents",
	"aery-doctor",
	"aery-team",
	"subagent/index",
	"marketplace",
	"session-auto-name",
	"upstream-notify",
	"init-prompt",
] as const;

export interface CoreExtensionDiagnostic {
	repoExists: boolean;
	missingFiles: string[];
	missingSettingsEntries: string[];
}

export interface CoreExtensionWireResult extends CoreExtensionDiagnostic {
	added: string[];
}

export interface CoreExtensionEnsureResult extends CoreExtensionWireResult {
	status: "installed" | "offline" | "ok";
	repoPath: string;
	settingsPath: string;
	error?: string;
}

export function getCoreExtensionFilePaths(repoPath: string): string[] {
	return CORE_EXTENSION_PATHS.map((extensionPath) => join(repoPath, "core", `${extensionPath}.ts`));
}

function readSettingsExtensions(settingsPath: string): string[] {
	if (!existsSync(settingsPath)) return [];
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { extensions?: unknown };
		return Array.isArray(settings.extensions)
			? settings.extensions.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
}

export function diagnoseCoreExtensions(repoPath: string, settingsPath: string): CoreExtensionDiagnostic {
	const expectedPaths = getCoreExtensionFilePaths(repoPath);
	const repoExists = existsSync(repoPath);
	const settingsExtensions = new Set(readSettingsExtensions(settingsPath));
	return {
		repoExists,
		missingFiles: repoExists ? expectedPaths.filter((extensionPath) => !existsSync(extensionPath)) : expectedPaths,
		missingSettingsEntries: expectedPaths.filter(
			(extensionPath) => existsSync(extensionPath) && !settingsExtensions.has(extensionPath),
		),
	};
}

export function wireCoreExtensions(repoPath: string, settingsPath: string): CoreExtensionWireResult {
	const diagnostic = diagnoseCoreExtensions(repoPath, settingsPath);
	if (!diagnostic.repoExists) return { ...diagnostic, added: [] };

	const parsedSettings = (existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {}) as {
		extensions?: unknown;
	};
	const existingExtensions = Array.isArray(parsedSettings.extensions)
		? parsedSettings.extensions.filter((value): value is string => typeof value === "string")
		: [];
	const settings: Record<string, unknown> & { extensions?: string[] } = {
		...parsedSettings,
		extensions: existingExtensions,
	};
	const existing = new Set<string>(existingExtensions);
	const added: string[] = [];
	for (const extensionPath of getCoreExtensionFilePaths(repoPath)) {
		if (!existsSync(extensionPath) || existing.has(extensionPath)) continue;
		settings.extensions = settings.extensions ?? [];
		settings.extensions.push(extensionPath);
		existing.add(extensionPath);
		added.push(extensionPath);
	}

	if (added.length > 0) {
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	}

	const nextDiagnostic = diagnoseCoreExtensions(repoPath, settingsPath);
	return { ...nextDiagnostic, added };
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * Migrate sessions from ~/.aery/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.aery/agent/ instead of
 * ~/.aery/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/eminent337/aery/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by aery, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Wire any missing core extensions for existing users who already have aery-extensions installed.
 * Runs on every startup but is idempotent — only adds extensions not already in settings.
 */
function wireMissingCoreExtensions(): void {
	const agentDir = getAgentDir();
	const repoPath = join(agentDir, "git", "github.com", "eminent337", "aery-extensions");
	const settingsPath = join(agentDir, "settings.json");

	if (!existsSync(repoPath)) return;

	try {
		wireCoreExtensions(repoPath, settingsPath);
	} catch {
		// Silent fail
	}
}

/**
 * Ensure aery-extensions is cloned and core extensions are wired.
 * Called at startup — installs aery-extensions if missing, then wires core extensions.
 * Safe to call multiple times (idempotent).
 *
 * @returns core extension bootstrap status and diagnostics
 */
export function ensureCoreExtensions(): CoreExtensionEnsureResult {
	const agentDir = getAgentDir();
	const repoPath = join(agentDir, "git", "github.com", "eminent337", "aery-extensions");
	const settingsPath = join(agentDir, "settings.json");

	// Clone if missing
	if (!existsSync(repoPath)) {
		try {
			mkdirSync(join(agentDir, "git", "github.com", "eminent337"), { recursive: true });
			execSync(`git clone --depth=1 https://github.com/eminent337/aery-extensions.git "${repoPath}"`, {
				stdio: "pipe",
				timeout: 30000,
			});
			return { ...wireCoreExtensions(repoPath, settingsPath), status: "installed", repoPath, settingsPath };
		} catch (error) {
			// Network unavailable or git missing
			return {
				...diagnoseCoreExtensions(repoPath, settingsPath),
				added: [],
				status: "offline",
				repoPath,
				settingsPath,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// Repo exists — pull updates in the background (fire and forget)
	try {
		spawnSync("git", ["-C", repoPath, "pull", "--ff-only", "--quiet"], {
			timeout: 10000,
			stdio: "pipe",
		});
	} catch {
		// Ignore pull failures — offline or git missing
	}

	// Wire any newly added core extensions
	try {
		return { ...wireCoreExtensions(repoPath, settingsPath), status: "ok", repoPath, settingsPath };
	} catch (error) {
		return {
			...diagnoseCoreExtensions(repoPath, settingsPath),
			added: [],
			status: "ok",
			repoPath,
			settingsPath,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function formatCoreExtensionAttentionMessage(result: CoreExtensionEnsureResult): string | undefined {
	if (result.status === "offline") {
		return "Extensions not installed (no network). Run aery again with network access, or run: aery update --extensions";
	}

	if (result.error) {
		return `Core extensions need attention: ${result.error}. Run: aery update --extensions`;
	}

	if (result.missingFiles.length > 0) {
		return `Core extensions need attention: ${result.missingFiles.length} core extension file(s) are missing. Run: aery update --extensions`;
	}

	if (result.missingSettingsEntries.length > 0) {
		return `Core extensions need attention: ${result.missingSettingsEntries.length} core extension setting(s) are missing. Run: aery update --extensions`;
	}

	return undefined;
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	wireMissingCoreExtensions();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
