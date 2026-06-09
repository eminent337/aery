/**
 * Aery Marketplace
 *
 * Browse, install, and uninstall extension packs from
 * github.com/eminent337/aery-extensions via /marketplace command.
 *
 * Install clones git repos to ~/.aery/agent/git/github.com/<source>
 * and registers file paths in ~/.aery/agent/settings.json.
 * The marketplace/loader extension loads them at session start.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";

const REGISTRY_URL = "https://raw.githubusercontent.com/eminent337/aery-extensions/main/registry.json";
const SETTINGS_PATH = join(homedir(), ".aery", "agent", "settings.json");
const GIT_BASE = join(homedir(), ".aery", "agent", "git", "github.com");

interface Pack {
	description: string;
	source: string;
	install?: string;
	file?: string;
	postInstall?: string;
	extensions?: string[];
	auto?: boolean;
	coming_soon?: boolean;
	type?: "extension" | "skills" | "bundle";
}

interface Registry {
	version: string;
	packs: Record<string, Pack>;
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function getSettings(): Record<string, unknown> {
	if (!existsSync(SETTINGS_PATH)) return {};
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function saveSettings(settings: Record<string, unknown>): void {
	writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function isInstalled(packName: string, pack: Pack): boolean {
	const s = getSettings();
	if (pack.file) {
		const filePath = join(GIT_BASE, pack.source, pack.file);
		const exts = (s.extensions ?? []) as string[];
		return exts.some((e: string) => e === filePath || e.includes(pack.file!));
	}
	const pkgs = (s.packages ?? []) as string[];
	return pkgs.some((p: string) => p.includes(pack.source));
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

async function installPack(
	packName: string,
	pack: Pack,
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ exitCode: number; stderr?: string }>,
	ctx: { ui: { notify: (msg: string, type?: "error" | "info" | "warning") => void } },
): Promise<boolean> {
	const repoDir = join(GIT_BASE, pack.source);

	// Clone repo if not already present, otherwise pull latest
	if (!existsSync(repoDir)) {
		const repoUrl = `https://github.com/${pack.source}`;
		const cloneResult = await execFn("git", ["clone", repoUrl, repoDir], { timeout: 60_000 });
		if (cloneResult.exitCode !== 0) {
			ctx.ui.notify(`Clone failed: ${cloneResult.stderr?.slice(0, 100)}`, "error");
			return false;
		}
	} else {
		await execFn("git", ["-C", repoDir, "pull", "--ff-only"], { timeout: 30_000 }).catch(() => {});
	}

	const s = getSettings();

	if (pack.file) {
		// Wire specific file
		const filePath = join(GIT_BASE, pack.source, pack.file);
		if (!existsSync(filePath)) {
			ctx.ui.notify(`File not found: ${filePath}`, "error");
			return false;
		}
		const exts = (s.extensions ?? []) as string[];
		if (!exts.includes(filePath)) exts.push(filePath);
		s.extensions = exts;
		if (pack.postInstall) {
			const parts = pack.postInstall.split(" ");
			await execFn(parts[0], parts.slice(1), { timeout: 60_000 }).catch(e =>
				ctx.ui.notify(`postInstall warning: ${e}`, "warning"),
			);
		}
	} else {
		// Wire whole package
		const pkgs = (s.packages ?? []) as string[];
		const repoUrl = `https://github.com/${pack.source}`;
		if (!pkgs.includes(repoUrl)) pkgs.push(repoUrl);
		s.packages = pkgs;
	}

	saveSettings(s);
	return true;
}

function uninstallPack(packName: string, pack: Pack): boolean {
	const s = getSettings();
	let removed = false;

	if (pack.file) {
		const filePath = join(GIT_BASE, pack.source, pack.file);
		const exts = (s.extensions ?? []) as string[];
		const before = exts.length;
		s.extensions = exts.filter((e: string) => e !== filePath && !e.includes(pack.file!));
		removed = (s.extensions as string[]).length < before;
	} else {
		const pkgs = (s.packages ?? []) as string[];
		const before = pkgs.length;
		s.packages = pkgs.filter((p: string) => !p.includes(pack.source));
		removed = (s.packages as string[]).length < before;
	}

	if (removed) saveSettings(s);
	return removed;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function marketplaceExtension(aery: ExtensionAPI) {
	aery.registerCommand("marketplace", {
		description: "Browse, install, or uninstall extensions. Usage: /marketplace [install|uninstall|list] [name]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const packArg = parts[1]?.toLowerCase();

			ctx.ui.notify("Fetching extension registry...", "info");
			const res = await fetch(REGISTRY_URL);
			if (!res.ok) {
				ctx.ui.notify("Failed to fetch registry. Check your connection.", "error");
				return;
			}
			const registry = (await res.json()) as Registry;

			const availablePacks = Object.entries(registry.packs).filter(([, p]) => !p.auto);

			// /marketplace install [name]
			if (subcommand === "install") {
				let packName = packArg;
				let pack = packName ? registry.packs[packName] : undefined;

				if (!pack) {
					const options = availablePacks
						.filter(([, p]) => !p.coming_soon)
						.map(([name, p]) => {
							const tag = p.type === "skills" ? "[skills]" : p.type === "bundle" ? "[bundle]" : "[ext]";
							const installed = isInstalled(name, p) ? " ✓" : "";
							return `${name} ${tag}${installed} — ${p.description}`;
						});
					const choice = await ctx.ui.select("Select extension to install:", options);
					if (!choice) return;
					packName = choice.split(" ")[0];
					pack = registry.packs[packName];
				}

				if (!pack) {
					ctx.ui.notify(`Unknown extension: ${packName}`, "error");
					return;
				}
				if (pack.coming_soon) {
					ctx.ui.notify(`${packName} is coming soon!`, "info");
					return;
				}
				if (isInstalled(packName, pack)) {
					ctx.ui.notify(`${packName} is already installed.`, "info");
					return;
				}

				ctx.ui.notify(`Installing ${packName}...`, "info");
				const execFn = async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
					const res = await aery.exec(cmd, args, opts);
					return { exitCode: (res as any).code ?? 0, stderr: res.stderr };
				};
				const ok = await installPack(packName, pack, execFn, ctx);
				if (ok) ctx.ui.notify(`✓ ${packName} installed! Restart Aery to activate.`, "info");
				else ctx.ui.notify("Install failed.", "error");
				return;
			}

			// /marketplace uninstall [name]
			if (subcommand === "uninstall" || subcommand === "remove") {
				let packName = packArg;
				let pack = packName ? registry.packs[packName] : undefined;

				if (!pack) {
					const installed = availablePacks.filter(([name, p]) => isInstalled(name, p));
					if (installed.length === 0) {
						ctx.ui.notify("No extensions installed via marketplace.", "info");
						return;
					}
					const options = installed.map(([name, p]) => {
						const tag = p.type === "skills" ? "[skills]" : "[ext]";
						return `${name} ${tag} — ${p.description}`;
					});
					const choice = await ctx.ui.select("Select extension to uninstall:", options);
					if (!choice) return;
					packName = choice.split(" ")[0];
					pack = registry.packs[packName];
				}

				if (!pack) {
					ctx.ui.notify(`Unknown extension: ${packName}`, "error");
					return;
				}

				const confirm = await ctx.ui.select(`Uninstall "${packName}"?`, ["Yes, uninstall", "Cancel"]);
				if (!confirm || confirm === "Cancel") return;

				const removed = uninstallPack(packName, pack);
				if (removed) {
					ctx.ui.notify(`✓ ${packName} uninstalled. Restart Aery to apply.`, "info");
				} else {
					ctx.ui.notify(`${packName} was not found in settings.`, "warning");
				}
				return;
			}

			// /marketplace list
			if (subcommand === "list") {
				const installed = availablePacks.filter(([n, p]) => isInstalled(n, p)).map(([n]) => n);
				const msg =
					installed.length > 0 ? `Installed: ${installed.join(", ")}` : "No extensions installed via marketplace.";
				ctx.ui.notify(msg, "info");
				return;
			}

			// /marketplace (no args) — browse
			const options = availablePacks.map(([name, pack]) => {
				if (pack.coming_soon) return `${name} [coming soon] — ${pack.description}`;
				const tag = pack.type === "skills" ? "[skills]" : pack.type === "bundle" ? "[bundle]" : "[ext]";
				const installed = isInstalled(name, pack) ? " ✓" : "";
				return `${name} ${tag}${installed} — ${pack.description}`;
			});
			options.push("─────────────────────────────────────────");
			options.push("List installed");

			const choice = await ctx.ui.select("Aery Marketplace", options);
			if (!choice) return;

			if (choice.includes("List installed")) {
				const installed = availablePacks.filter(([name, p]) => isInstalled(name, p)).map(([name]) => name);
				ctx.ui.notify(installed.length > 0 ? `Installed: ${installed.join(", ")}` : "None installed.", "info");
				return;
			}

			const packName = choice.split(" ")[0];
			const pack = registry.packs[packName];
			if (!pack || pack.coming_soon) return;

			// Toggle install/uninstall
			if (isInstalled(packName, pack)) {
				const confirm = await ctx.ui.select(`"${packName}" is installed. Uninstall?`, ["Yes, uninstall", "Cancel"]);
				if (!confirm || confirm === "Cancel") return;
				const removed = uninstallPack(packName, pack);
				if (removed) ctx.ui.notify(`✓ ${packName} uninstalled. Restart Aery.`, "info");
				else ctx.ui.notify(`${packName} not found in settings.`, "warning");
			} else {
				const confirm = await ctx.ui.select(`Install "${packName}"?\n${pack.description}`, [
					"Yes, install",
					"Cancel",
				]);
				if (!confirm || confirm === "Cancel") return;
				ctx.ui.notify(`Installing ${packName}...`, "info");
				const execFn = async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
					const res = await aery.exec(cmd, args, opts);
					return { exitCode: (res as any).code ?? 0, stderr: res.stderr };
				};
				const ok = await installPack(packName, pack, execFn, ctx);
				if (ok) ctx.ui.notify(`✓ ${packName} installed! Restart Aery.`, "info");
			}
		},
	});
}
