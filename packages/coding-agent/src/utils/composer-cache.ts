import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "node:process";

export interface ComposerEntry {
	prompt: string;
	timestamp: number;
	sessionId?: string;
}

const COMPOSER_CACHE_FILE = "composer-cache.json";
const MAX_ENTRIES = 10;

function getComposerCacheDir(): string {
	return join(env.HOME ?? "~", ".aery", "agent");
}

function getComposerCachePath(): string {
	return join(getComposerCacheDir(), COMPOSER_CACHE_FILE);
}

/**
 * Load the composer cache from disk.
 * Returns empty array if the file doesn't exist or is invalid.
 */
export async function loadComposerCache(): Promise<ComposerEntry[]> {
	try {
		const content = await readFile(getComposerCachePath(), "utf-8");
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidComposerEntry);
	} catch {
		return [];
	}
}

function isValidComposerEntry(entry: unknown): entry is ComposerEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const obj = entry as Record<string, unknown>;
	return typeof obj.prompt === "string" && typeof obj.timestamp === "number";
}

/**
 * Save the composer cache to disk.
 */
export async function saveComposerCache(entries: ComposerEntry[]): Promise<void> {
	const cachePath = getComposerCachePath();
	const cacheDir = dirname(cachePath);
	await mkdir(cacheDir, { recursive: true });
	await writeFile(cachePath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Record a new prompt to the cache.
 * Prepends the entry, trims to MAX_ENTRIES, and saves.
 */
export async function recordPrompt(prompt: string, sessionId?: string): Promise<void> {
	const entries = await loadComposerCache();
	const newEntry: ComposerEntry = {
		prompt: prompt.slice(0, 200), // Trim long prompts
		timestamp: Date.now(),
		sessionId,
	};
	entries.unshift(newEntry);
	const trimmed = entries.slice(0, MAX_ENTRIES);
	await saveComposerCache(trimmed);
}

/**
 * Get the most recent prompts from the cache.
 */
export async function getRecentPrompts(limit = 5): Promise<ComposerEntry[]> {
	const entries = await loadComposerCache();
	return entries.slice(0, limit);
}

/**
 * Clear the composer cache.
 */
export async function clearComposerCache(): Promise<void> {
	const cachePath = getComposerCachePath();
	if (existsSync(cachePath)) {
		await unlink(cachePath);
	}
}
