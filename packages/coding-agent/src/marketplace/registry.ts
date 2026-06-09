/**
 * Aery Marketplace — Registry Fetcher
 * Fetches the sovereign Aery registry with local caching and fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Registry } from "./types";

const REGISTRY_URL = "https://raw.githubusercontent.com/eminent337/aery-extensions/main/registry.json";

const CACHE_DIR = join(homedir(), ".aery", "marketplace");
const CACHE_PATH = join(CACHE_DIR, "registry-cache.json");
const CACHE_TTL_MS = 1000 * 60 * 15; // 15 minutes

interface CachedRegistry {
	fetchedAt: number;
	registry: Registry;
}

function loadCache(): Registry | null {
	try {
		if (!existsSync(CACHE_PATH)) return null;
		const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CachedRegistry;
		if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
		return raw.registry;
	} catch {
		return null;
	}
}

function saveCache(registry: Registry): void {
	try {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		const payload: CachedRegistry = { fetchedAt: Date.now(), registry };
		writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
	} catch {
		// Cache write failure is non-fatal
	}
}

export async function fetchRegistry(force = false): Promise<Registry | null> {
	if (!force) {
		const cached = loadCache();
		if (cached) return cached;
	}

	try {
		const res = await fetch(REGISTRY_URL, {
			headers: { "Cache-Control": "no-cache" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return loadCache(); // fall back to stale cache
		const registry = (await res.json()) as Registry;
		saveCache(registry);
		return registry;
	} catch {
		return loadCache(); // use stale cache on network error
	}
}

export function clearRegistryCache(): void {
	try {
		if (existsSync(CACHE_PATH)) {
			writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: 0, registry: null }));
		}
	} catch {}
}
