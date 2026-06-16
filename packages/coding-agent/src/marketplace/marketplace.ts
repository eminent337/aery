/**
 * Aery Marketplace — Command Handler
 * Registers /marketplace with all subcommands: browse, install, uninstall, update, list, info
 * Better than AERY: subcommands, version pinning, capability conflict detection, tier badges.
 */

import type { ExtensionAPI } from "@aryee337/aery";
import type { AutocompleteItem } from "@aryee337/aery-tui";
import { detectConflicts, getInstalledPacks, installPack, isInstalled, uninstallPack, updatePack } from "./engine";
import { fetchRegistry, loadCache } from "./registry";
import type { Pack, Registry } from "./types";

const MARKETPLACE_SUBCOMMAND_COMPLETIONS: AutocompleteItem[] = [
	{ value: "install ", label: "install", description: "Install an extension" },
	{ value: "uninstall ", label: "uninstall", description: "Uninstall an extension" },
	{ value: "remove ", label: "remove", description: "Remove an extension" },
	{ value: "update ", label: "update", description: "Update an extension" },
	{ value: "list", label: "list", description: "List installed extensions" },
	{ value: "browse", label: "browse", description: "Browse all extensions" },
	{ value: "info ", label: "info", description: "Show info for an extension" },
];

function matchCompletionPrefix(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
	const lower = prefix.toLowerCase();
	const matches = items.filter(m => m.value.toLowerCase().startsWith(lower));
	return matches.length > 0 ? matches : null;
}

function getMarketplaceArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const parts = prefix.trimStart().split(/\s+/);
	if (parts.length <= 1) {
		return matchCompletionPrefix(MARKETPLACE_SUBCOMMAND_COMPLETIONS, parts[0] || "");
	}

	const sub = parts[0]?.toLowerCase();
	const verbPrefix = parts[1] || "";

	if (parts.length === 2) {
		if (sub === "install" || sub === "info") {
			const cache = loadCache();
			if (cache) {
				const available = Object.entries(cache.packs)
					.filter(([, p]) => !p.auto)
					.map(([name]) => ({
						value: name,
						label: name,
						description: "extension in registry",
					}));
				return matchCompletionPrefix(available, verbPrefix);
			}
		} else if (sub === "update" || sub === "uninstall" || sub === "remove") {
			const installed = getInstalledPacks();
			const dynamicItems: AutocompleteItem[] = installed.map(i => ({
				value: i.name,
				label: i.name,
				description: "installed extension",
			}));
			if (sub === "update") {
				dynamicItems.unshift({ value: "--all", label: "--all", description: "Update all installed extensions" });
				dynamicItems.unshift({ value: "-a", label: "-a", description: "Update all installed extensions" });
			}
			return matchCompletionPrefix(dynamicItems, verbPrefix);
		}
	}

	return null;
}

const TIER_BADGE: Record<string, string> = {
	core: "⚙",
	verified: "✦",
	community: "◆",
};

function formatPack(name: string, pack: Pack, installed: boolean): string {
	const tier = TIER_BADGE[pack.tier ?? "community"] ?? "◆";
	const tag = pack.type === "skills" ? "[skills]" : pack.type === "bundle" ? "[bundle]" : "[ext]";
	const status = installed ? " ✓" : "";
	const soon = pack.coming_soon ? " [coming soon]" : "";
	return `${tier} ${name} ${tag}${status}${soon} — ${pack.description}`;
}

function notifyFn(api: ExtensionAPI) {
	return (msg: string, _level: "info" | "warning" | "error") => {
		api.sendUserMessage(msg);
	};
}

async function requireRegistry(api: ExtensionAPI, force = false): Promise<Registry | null> {
	api.sendUserMessage("🔍 Fetching Aery extension registry...");
	const registry = await fetchRegistry(force);
	if (!registry) {
		api.sendUserMessage(
			"❌ Could not reach the registry. Check your connection. (Using cached version if available.)",
		);
		return null;
	}
	return registry;
}

export default function registerMarketplace(aery: ExtensionAPI) {
	aery.registerMessageRenderer<any>("marketplace_grid", msg => {
		const packs = msg.details?.packs;
		if (!packs || packs.length === 0) return undefined;

		const { FlexBox, Box, Text } = require("@aryee337/aery-tui");
		const chalk = require("chalk");

		const grid = new FlexBox({ direction: "column", gap: 1 });
		const cols = 2;

		const TIER_BADGE: Record<string, string> = {
			core: "⚙",
			verified: "✦",
			community: "◆",
		};

		for (let i = 0; i < packs.length; i += cols) {
			const row = new FlexBox({ direction: "row", gap: 2 });
			for (let j = 0; j < cols; j++) {
				const item = packs[i + j];
				if (item) {
					const badge = TIER_BADGE[item.pack.tier ?? "community"] ?? "◆";
					const title = `${badge} ${item.name} ${item.installed ? chalk.green("✓") : ""}`;
					const desc = item.pack.description ?? "";

					const card = new FlexBox({ direction: "column" });
					card.addItem(new Text(chalk.bold.white(title), 1, 0));
					card.addItem(new Text(chalk.gray(desc), 1, 0));

					row.addItem(card, { grow: 1 });
				} else {
					row.addItem(new Box(0, 0), { grow: 1 });
				}
			}
			grid.addItem(row);
		}

		return grid;
	});

	aery.registerCommand("marketplace", {
		description:
			"Browse, install, uninstall, update Aery extensions. Usage: /marketplace [install|uninstall|update|list|info] [name]",
		getArgumentCompletions: getMarketplaceArgumentCompletions,
		handler: async (args: string) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";
			const packArg = parts[1]?.toLowerCase() ?? "";
			const notify = notifyFn(aery);

			// ── /marketplace list / browse ─────────────────────────────────────────
			if (sub === "list" || sub === "browse") {
				const registry = await requireRegistry(aery);
				if (!registry) return;

				let packsToRender: { name: string; pack: Pack; installed: boolean }[] = [];
				if (sub === "list") {
					const installed = getInstalledPacks();
					if (installed.length === 0) {
						aery.sendUserMessage("No extensions installed via marketplace.");
						return;
					}
					packsToRender = installed.map(i => ({
						name: i.name,
						pack: registry.packs[i.name] ?? {},
						installed: true,
					}));
				} else {
					// browse
					const availablePacks = Object.entries(registry.packs).filter(([, p]) => !p.auto);
					packsToRender = availablePacks.map(([name, pack]) => ({
						name,
						pack,
						installed: isInstalled(name, pack),
					}));
				}

				aery.sendMessage({
					customType: "marketplace_grid",
					content: sub === "list" ? "**Installed Extensions:**" : "**Aery Marketplace Extensions:**",
					details: { packs: packsToRender },
					display: true,
				});
				return;
			}

			// ── /marketplace info [name] ───────────────────────────────────
			if (sub === "info") {
				const registry = await requireRegistry(aery);
				if (!registry) return;
				const pack = registry.packs[packArg];
				if (!pack) {
					aery.sendUserMessage(`Unknown extension: "${packArg}". Run /marketplace to browse.`);
					return;
				}
				const caps = pack.capabilities;
				const lines = [
					`**${packArg}** [${pack.tier ?? "community"}]`,
					`${pack.description}`,
					`Source: github.com/${pack.source}`,
					pack.version ? `Version: ${pack.version}` : "",
					caps?.tools?.length ? `Tools: ${caps.tools.join(", ")}` : "",
					caps?.events?.length ? `Events: ${caps.events.join(", ")}` : "",
					caps?.requires?.length ? `Requires: ${caps.requires.join(", ")}` : "",
					caps?.env?.length ? `Env vars needed: ${caps.env.join(", ")}` : "",
					isInstalled(packArg, pack) ? "**Status: ✓ Installed**" : "Status: Not installed",
				].filter(Boolean);
				aery.sendUserMessage(lines.join("\n"));
				return;
			}

			// ── /marketplace install [name] ────────────────────────────────
			if (sub === "install") {
				const registry = await requireRegistry(aery);
				if (!registry) return;
				const availablePacks = Object.entries(registry.packs).filter(([, p]) => !p.auto);

				let packName = packArg;
				let pack: Pack | undefined = packName ? registry.packs[packName] : undefined;

				if (!pack) {
					const options = availablePacks
						.filter(([, p]) => !p.coming_soon)
						.map(([name, p]) => formatPack(name, p, isInstalled(name, p)));
					const choice = await (aery as any).ui?.select("Select extension to install:", options);
					if (!choice) return;
					packName = choice.split(" ").slice(1)[0]?.replace(/\s.*/, "") ?? "";
					pack = registry.packs[packName];
				}

				if (!pack) {
					aery.sendUserMessage(`Unknown: "${packName}"`);
					return;
				}
				if (pack.coming_soon) {
					aery.sendUserMessage(`${packName} is coming soon! Watch github.com/eminent337/aery-extensions`);
					return;
				}
				if (isInstalled(packName, pack)) {
					aery.sendUserMessage(`${packName} is already installed. Use /marketplace update ${packName} to update.`);
					return;
				}

				// Capability conflict check
				if (pack.capabilities) {
					const installed = getInstalledPacks();
					const allCaps: Record<string, any> = {};
					for (const inst of installed) {
						const p = registry.packs[inst.name];
						if (p?.capabilities) allCaps[inst.name] = p.capabilities;
					}
					const conflicts = detectConflicts(packName, pack.capabilities, allCaps);
					if (conflicts.length > 0) {
						aery.sendUserMessage(conflicts.join("\n"));
					}
				}

				const ok = await installPack(packName, pack, aery.exec.bind(aery), notify);
				if (ok) aery.sendUserMessage(`✅ **${packName}** installed! Restart Aery to activate.`);
				return;
			}

			// ── /marketplace uninstall [name] ─────────────────────────────
			if (sub === "uninstall" || sub === "remove") {
				const registry = await requireRegistry(aery);
				if (!registry) return;

				let packName = packArg;
				let pack: Pack | undefined = packName ? registry.packs[packName] : undefined;

				if (!pack) {
					const installed = getInstalledPacks();
					if (installed.length === 0) {
						aery.sendUserMessage("No extensions installed.");
						return;
					}
					const options = installed.map(i => {
						const p = registry.packs[i.name];
						return p ? formatPack(i.name, p, true) : `◆ ${i.name} [ext] ✓`;
					});
					const choice = await (aery as any).ui?.select("Select extension to uninstall:", options);
					if (!choice) return;
					packName = choice.split(" ").slice(1)[0]?.replace(/\s.*/, "") ?? "";
					pack = registry.packs[packName];
				}

				if (!pack) {
					aery.sendUserMessage(`Unknown: "${packName}"`);
					return;
				}
				uninstallPack(packName, pack, notify);
				return;
			}

			// ── /marketplace update [name|--all] ──────────────────────────
			if (sub === "update") {
				const registry = await requireRegistry(aery, true); // force-refresh
				if (!registry) return;

				if (packArg === "--all" || packArg === "-a") {
					const installed = getInstalledPacks();
					if (installed.length === 0) {
						aery.sendUserMessage("Nothing to update.");
						return;
					}
					let updated = 0;
					for (const inst of installed) {
						const pack = registry.packs[inst.name];
						if (!pack) continue;
						const ok = await updatePack(inst.name, pack, aery.exec.bind(aery), notify);
						if (ok) updated++;
					}
					aery.sendUserMessage(`✅ Updated ${updated}/${installed.length} extensions. Restart Aery to apply.`);
					return;
				}

				const packName = packArg;
				const pack = registry.packs[packName];
				if (!pack) {
					aery.sendUserMessage(`Unknown: "${packName}"`);
					return;
				}
				await updatePack(packName, pack, aery.exec.bind(aery), notify);
				return;
			}

			// ── /marketplace (browse) ──────────────────────────────────────
			const registry = await requireRegistry(aery);
			if (!registry) return;

			const availablePacks = Object.entries(registry.packs).filter(([, p]) => !p.auto);
			const options = availablePacks.map(([name, pack]) => formatPack(name, pack, isInstalled(name, pack)));

			const tierLegend = "⚙ core  ✦ verified  ◆ community  ✓ installed";
			options.unshift(`── ${tierLegend} ──`);
			options.push("─────────────────────────────────");
			options.push("📋 List installed");
			options.push("🔄 Update all");

			const choice =
				(await (aery as any).ui?.custom?.(
					(tui: any, _theme: any, _kb: any, done: any) => {
						const { MarketplaceGrid } = require("./ui");
						// Pass the raw packs so the UI can draw detailed cards
						return new MarketplaceGrid(tui, availablePacks, getInstalledPacks(), done);
					},
					{ overlay: true },
				)) ?? (await (aery as any).ui?.select("🛒 Aery Marketplace", options));

			if (!choice) return;

			if (choice.includes("List installed")) {
				const installed = getInstalledPacks();
				if (installed.length === 0) {
					aery.sendUserMessage("No extensions installed via marketplace.");
					return;
				}
				aery.sendMessage({
					customType: "marketplace_grid",
					content: "**Installed Extensions:**",
					details: {
						packs: installed.map(i => ({ name: i.name, pack: registry.packs[i.name] ?? {}, installed: true })),
					},
					display: true,
				});
				return;
			}

			if (choice.includes("Update all")) {
				const installed = getInstalledPacks();
				for (const inst of installed) {
					const pack = registry.packs[inst.name];
					if (pack) await updatePack(inst.name, pack, aery.exec.bind(aery), notify);
				}
				return;
			}

			// Extract pack name from formatted string (skip tier badge + space)
			const packName = choice.replace(/^[⚙✦◆]\s/, "").split(" ")[0];
			const pack = registry.packs[packName];
			if (!pack || pack.coming_soon) return;

			if (isInstalled(packName, pack)) {
				uninstallPack(packName, pack, notify);
			} else {
				const ok = await installPack(packName, pack, aery.exec.bind(aery), notify);
				if (ok) aery.sendUserMessage(`✅ **${packName}** installed! Restart Aery to activate.`);
			}
		},
	});
}
