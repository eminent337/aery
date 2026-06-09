import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MarketplaceRegistry } from "./types";

export class RegistryFetcher {
	private readonly registryUrl =
		"https://raw.githubusercontent.com/eminent337/aery/main/packages/aery-extensions/registry.json";

	async fetchRegistry(fallbackToLocal = true): Promise<MarketplaceRegistry> {
		try {
			const res = await fetch(this.registryUrl);
			if (!res.ok) {
				throw new Error(`Failed to fetch registry: ${res.statusText}`);
			}
			return (await res.json()) as MarketplaceRegistry;
		} catch (error) {
			if (fallbackToLocal) {
				return this.readLocalRegistry();
			}
			throw error;
		}
	}

	async readLocalRegistry(): Promise<MarketplaceRegistry> {
		const localPath = path.resolve(import.meta.dir, "../../registry.json");
		const content = await fs.readFile(localPath, "utf-8");
		return JSON.parse(content) as MarketplaceRegistry;
	}
}
