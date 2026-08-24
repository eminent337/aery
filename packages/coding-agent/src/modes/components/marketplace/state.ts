import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../../discovery/helpers";
import { PluginManager } from "../../../extensibility/plugins/manager";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../../extensibility/plugins/marketplace";
import { getInstalledPacks, installPack, isInstalled, uninstallPack } from "../../../marketplace/engine";
import { fetchRegistry, loadCache } from "../../../marketplace/registry";
import type { Registry } from "../../../marketplace/types";
import type { HubExtensionItem, HubTabId } from "./types";

export class HubStateManager {
	#cwd: string;

	constructor(cwd: string) {
		this.#cwd = cwd;
	}

	async loadHubState(): Promise<HubExtensionItem[]> {
		const items: HubExtensionItem[] = [];
		const seenIds = new Set<string>();

		// 1. Fetch Marketplace Registry
		let registry: Registry | null = null;
		try {
			registry = await fetchRegistry(false);
		} catch {
			registry = loadCache();
		}

		// 2. Fetch Installed Marketplace Packs
		const installedPacks = getInstalledPacks();
		const installedPacksMap = new Map(installedPacks.map(p => [p.name, p]));

		// 3. Fetch npm plugins
		const npmManager = new PluginManager();
		let npmPlugins: Array<{ name: string; version: string; enabled?: boolean; manifest: any }> = [];
		try {
			npmPlugins = await npmManager.list();
		} catch {}

		// 4. Fetch Marketplace Manager Installed Plugins (project + user)
		let marketplaceInstalled: any[] = [];
		try {
			const mm = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(this.#cwd),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});
			marketplaceInstalled = await mm.listInstalledPlugins();
		} catch {}

		// Add Marketplace Packs
		if (registry?.packs) {
			for (const [name, pack] of Object.entries(registry.packs)) {
				const installedPack = installedPacksMap.get(name);
				const isInst = !!installedPack || isInstalled(name, pack);
				const currentVersion = installedPack?.version ?? pack.version ?? "1.0.0";
				const latestVersion = pack.version ?? "1.0.0";

				items.push({
					id: name,
					name: name,
					version: currentVersion,
					latestVersion,
					description: pack.description ?? "",
					tier: (pack.tier as any) ?? "community",
					author: "Community",
					installed: isInst,
					enabled: true,
					scope: "user",
					capabilities: pack.capabilities?.tools ? pack.capabilities.tools.map((t: string) => `tool:${t}`) : [],
					raw: pack,
				});
				seenIds.add(name);
			}
		}

		// Add npm plugins
		for (const p of npmPlugins) {
			if (!seenIds.has(p.name)) {
				items.push({
					id: p.name,
					name: p.name,
					version: p.version,
					description: p.manifest?.description ?? "npm installed plugin",
					tier: "verified",
					installed: true,
					enabled: p.enabled !== false,
					scope: "npm",
					raw: p,
				});
				seenIds.add(p.name);
			}
		}

		// Add Marketplace Manager plugins
		for (const p of marketplaceInstalled) {
			if (!seenIds.has(p.id)) {
				const entry = p.entries[0];
				items.push({
					id: p.id,
					name: p.id,
					version: entry?.version ?? "1.0.0",
					description: entry?.description ?? "marketplace plugin",
					tier: "community",
					installed: true,
					enabled: entry?.enabled !== false,
					scope: p.scope ?? "project",
					shadowedBy: p.shadowedBy,
					raw: p,
				});
				seenIds.add(p.id);
			}
		}

		return items;
	}

	filterItems(items: HubExtensionItem[], tab: HubTabId, query: string): HubExtensionItem[] {
		const lowerQuery = query.trim().toLowerCase();

		return items.filter(item => {
			// Tab filtering
			if (tab === "installed" && !item.installed) return false;
			if (tab === "updates" && (!item.installed || !item.latestVersion || item.version === item.latestVersion)) {
				return false;
			}

			// Query filtering
			if (!lowerQuery) return true;
			const matchName = item.name.toLowerCase().includes(lowerQuery);
			const matchId = item.id.toLowerCase().includes(lowerQuery);
			const matchDesc = item.description.toLowerCase().includes(lowerQuery);
			const matchAuthor = item.author?.toLowerCase().includes(lowerQuery) ?? false;
			const matchCap = item.capabilities?.some(c => c.toLowerCase().includes(lowerQuery)) ?? false;

			return matchName || matchId || matchDesc || matchAuthor || matchCap;
		});
	}

	async installExtension(
		id: string,
		scope: "user" | "project" = "project",
	): Promise<{ ok: boolean; message: string }> {
		try {
			const cache = loadCache() ?? (await fetchRegistry(false));
			const pack = cache?.packs[id];
			if (pack) {
				const success = await installPack(
					id,
					pack,
					async () => ({ code: 0 }),
					() => {},
				);
				return { ok: success, message: success ? `Installed ${id}` : `Installation failed` };
			}

			// Fallback to MarketplaceManager
			const mm = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(this.#cwd),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});
			await mm.installPlugin(id, scope);
			return { ok: true, message: `Installed ${id}` };
		} catch (err: any) {
			return { ok: false, message: err.message || "Failed to install" };
		}
	}

	async uninstallExtension(id: string): Promise<{ ok: boolean; message: string }> {
		try {
			const cache = loadCache() ?? (await fetchRegistry(false));
			const pack = cache?.packs[id] ?? { description: "", source: id };
			const success = uninstallPack(id, pack, () => {});
			return { ok: success, message: success ? `Uninstalled ${id}` : `Uninstall failed` };
		} catch (err: any) {
			return { ok: false, message: err.message || "Failed to uninstall" };
		}
	}

	async toggleExtensionEnabled(
		id: string,
		enabled: boolean,
		scope: "user" | "project" = "project",
	): Promise<{ ok: boolean; message: string }> {
		try {
			const mm = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(this.#cwd),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});
			await mm.setPluginEnabled(id, enabled, scope);
			return { ok: true, message: `${enabled ? "Enabled" : "Disabled"} ${id}` };
		} catch (err: any) {
			return { ok: false, message: err.message || "Failed to toggle plugin state" };
		}
	}
}
