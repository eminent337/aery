/**
 * Aery Marketplace — Install/Uninstall/Update Engine
 * Better than AERY in 5 ways:
 *  1. Full uninstall with settings cleanup
 *  2. Version pinning via commit hash
 *  3. /marketplace update [name] and update --all
 *  4. Capability conflict detection before install
 *  5. Tier-aware installation (core | verified | community)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstalledPack, MarketplaceSettings, Pack, PackCapabilities } from "./types";

const SETTINGS_PATH = join(homedir(), ".aery", "agent", "settings.json");
const GIT_CACHE_BASE = join(homedir(), ".aery", "agent", "git", "github.com");

// ─── Settings Helpers ──────────────────────────────────────────────────────

export function getSettings(): MarketplaceSettings {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
	} catch {
		return {};
	}
}

export function saveSettings(s: MarketplaceSettings): void {
	const dir = join(homedir(), ".aery", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

export function getInstalledPacks(): InstalledPack[] {
	return getSettings().installed ?? [];
}

export function isInstalled(packName: string, pack: Pack): boolean {
	const settings = getSettings();
	const installed = settings.installed ?? [];
	if (installed.some(i => i.name === packName)) return true;

	// Legacy check for older installs
	const exts = settings.extensions ?? [];
	const pkgs = settings.packages ?? [];
	if (pack.file) return exts.some((e: string) => e.includes(pack.file!));
	return pkgs.some((p: string) => p.includes(pack.source));
}

// ─── Capability Conflict Detection ────────────────────────────────────────

export function detectConflicts(
	packName: string,
	caps: PackCapabilities,
	allInstalledCaps: Record<string, PackCapabilities>,
): string[] {
	const warnings: string[] = [];
	const exclusiveEvents = ["before_agent_start", "session_start"];

	for (const evt of caps.events ?? []) {
		if (!exclusiveEvents.includes(evt)) continue;
		for (const [installedName, installedCaps] of Object.entries(allInstalledCaps)) {
			if (installedCaps.events?.includes(evt)) {
				warnings.push(`⚠ Both "${packName}" and "${installedName}" subscribe to "${evt}" — order may matter`);
			}
		}
	}

	for (const tool of caps.tools ?? []) {
		for (const [installedName, installedCaps] of Object.entries(allInstalledCaps)) {
			if (installedCaps.tools?.includes(tool)) {
				warnings.push(`⚠ Tool name conflict: "${tool}" is registered by both "${packName}" and "${installedName}"`);
			}
		}
	}

	return warnings;
}

// ─── Git Operations ────────────────────────────────────────────────────────

async function gitClone(repoUrl: string, destDir: string, execFn: ExecFn): Promise<boolean> {
	if (!existsSync(GIT_CACHE_BASE)) mkdirSync(GIT_CACHE_BASE, { recursive: true });
	const result = await execFn("git", ["clone", "--depth=1", repoUrl, destDir], {
		timeout: 60_000,
	});
	return result.code === 0;
}

async function gitPull(repoDir: string, execFn: ExecFn): Promise<boolean> {
	const result = await execFn("git", ["-C", repoDir, "pull", "--ff-only"], {
		timeout: 30_000,
	});
	return result.code === 0;
}

async function gitRevParse(repoDir: string, execFn: ExecFn): Promise<string | undefined> {
	const result = await execFn("git", ["-C", repoDir, "rev-parse", "--short", "HEAD"], {
		timeout: 5_000,
	});
	return result.code === 0 ? result.stdout?.trim() : undefined;
}

type ExecFn = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number },
) => Promise<{
	code: number;
	stdout?: string;
	stderr?: string;
}>;

// ─── Install ──────────────────────────────────────────────────────────────

export async function installPack(
	packName: string,
	pack: Pack,
	execFn: ExecFn,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
	const repoDir = join(GIT_CACHE_BASE, pack.source);
	const repoUrl = `https://github.com/${pack.source}`;

	notify(`📦 Installing ${packName} [${pack.tier ?? "community"}]...`, "info");

	// Clone or pull
	if (!existsSync(repoDir)) {
		notify(`Cloning ${pack.source}...`, "info");
		const ok = await gitClone(repoUrl, repoDir, execFn);
		if (!ok) {
			notify(`Clone failed. Check your connection.`, "error");
			return false;
		}
	} else {
		notify(`Updating ${pack.source}...`, "info");
		await gitPull(repoDir, execFn);
	}

	const pinnedCommit = await gitRevParse(repoDir, execFn);
	const s = getSettings();
	s.installed = s.installed ?? [];
	s.extensions = s.extensions ?? [];
	s.packages = s.packages ?? [];

	if (pack.file) {
		const filePath = join(repoDir, pack.file);
		if (!existsSync(filePath)) {
			notify(`File not found: ${pack.file}`, "error");
			return false;
		}
		if (!s.extensions.includes(filePath)) s.extensions.push(filePath);
	} else {
		if (!s.packages.includes(repoUrl)) s.packages.push(repoUrl);
	}

	// Run postInstall if specified
	if (pack.postInstall) {
		const parts = pack.postInstall.split(" ");
		await execFn(parts[0], parts.slice(1), { timeout: 60_000 }).catch((e: unknown) =>
			notify(`postInstall warning: ${e}`, "warning"),
		);
	}

	// Record install with version pinning
	const existing = s.installed.findIndex(i => i.name === packName);
	const record: InstalledPack = {
		name: packName,
		source: pack.source,
		file: pack.file,
		installedAt: new Date().toISOString(),
		pinnedCommit,
		version: pack.version,
	};
	if (existing >= 0) {
		s.installed[existing] = record;
	} else {
		s.installed.push(record);
	}

	saveSettings(s);
	return true;
}

// ─── Uninstall ────────────────────────────────────────────────────────────

export function uninstallPack(
	packName: string,
	pack: Pack,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): boolean {
	const s = getSettings();
	let removed = false;

	if (pack.file) {
		const filePath = join(GIT_CACHE_BASE, pack.source, pack.file);
		const before = (s.extensions ?? []).length;
		s.extensions = (s.extensions ?? []).filter((e: string) => e !== filePath && !e.includes(pack.file!));
		removed = (s.extensions ?? []).length < before;
	} else {
		const before = (s.packages ?? []).length;
		s.packages = (s.packages ?? []).filter((p: string) => !p.includes(pack.source));
		removed = (s.packages ?? []).length < before;
	}

	// Remove from install record
	const beforeInstalled = (s.installed ?? []).length;
	s.installed = (s.installed ?? []).filter(i => i.name !== packName);
	if ((s.installed ?? []).length < beforeInstalled) removed = true;

	if (removed) {
		saveSettings(s);
		notify(`✓ ${packName} uninstalled. Restart Aery to apply.`, "info");
	} else {
		notify(`${packName} was not found in your settings.`, "warning");
	}

	return removed;
}

// ─── Update ───────────────────────────────────────────────────────────────

export async function updatePack(
	packName: string,
	pack: Pack,
	execFn: ExecFn,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
	const repoDir = join(GIT_CACHE_BASE, pack.source);
	if (!existsSync(repoDir)) {
		notify(`${packName} not found locally — installing fresh...`, "info");
		return installPack(packName, pack, execFn, notify);
	}

	notify(`🔄 Updating ${packName}...`, "info");
	const ok = await gitPull(repoDir, execFn);
	if (!ok) {
		notify(`Update failed for ${packName}.`, "error");
		return false;
	}

	const pinnedCommit = await gitRevParse(repoDir, execFn);
	const s = getSettings();
	s.installed = s.installed ?? [];
	const idx = s.installed.findIndex(i => i.name === packName);
	if (idx >= 0) {
		s.installed[idx].pinnedCommit = pinnedCommit;
		s.installed[idx].version = pack.version;
	}
	saveSettings(s);
	notify(`✓ ${packName} updated to ${pinnedCommit ?? "latest"}. Restart Aery to apply.`, "info");
	return true;
}
