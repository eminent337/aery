import { logger } from "@aryee337/aery-utils";
import { AgentStorage } from "../session/agent-storage";

let counts: Record<string, number> = {};
let storage: AgentStorage | undefined;
let loadPromise: Promise<void> | undefined;

/** Load persisted usage counts once per process; concurrent calls share one read. */
export function loadSlashCommandUsage(): Promise<void> {
	loadPromise ??= (async () => {
		try {
			const opened = await AgentStorage.open();
			const persisted = opened.listCommandUsage();
			// Keep hits recorded while the load was in flight visible in ranking.
			for (const name in counts) persisted[name] = (persisted[name] ?? 0) + counts[name]!;
			counts = persisted;
			storage = opened;
		} catch (err) {
			logger.warn("Failed to load slash command usage", { error: String(err) });
		}
	})();
	return loadPromise;
}

/** Usage count for a command name; ranks equal-score autocomplete matches. */
export function getSlashCommandUsage(name: string): number {
	return counts[name] ?? 0;
}

/** Increment a command's usage count; persists when the store is loaded. */
export function recordSlashCommandUsage(name: string): void {
	counts[name] = (counts[name] ?? 0) + 1;
	storage?.recordCommandUsage(name);
}

/** Test-only: reset in-memory usage state. */
export function __resetSlashCommandUsageForTests(): void {
	counts = {};
	storage = undefined;
	loadPromise = undefined;
}
