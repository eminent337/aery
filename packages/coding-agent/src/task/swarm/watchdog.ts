import { logger } from "@aryee337/aery-utils";
import { SwarmStore } from "./store.js";

/**
 * Recovers any Swarms that were interrupted due to a crash.
 * This runs at startup and marks them as paused so they can be manually resumed.
 */
export function startSwarmWatchdog(): void {
	try {
		const store = SwarmStore.open();
		const activeSwarms = store.listActive();

		if (activeSwarms.length === 0) {
			return;
		}

		logger.info(`SwarmWatchdog: Found ${activeSwarms.length} stranded swarm(s) to recover.`);

		for (const swarm of activeSwarms) {
			logger.info(`SwarmWatchdog: Pausing stranded swarm ${swarm.id} ("${swarm.workflow.name}")`);
			swarm.status = "paused";
			store.save(swarm);
		}
	} catch (err) {
		logger.error("SwarmWatchdog: Failed to recover swarms", { error: String(err) });
	}
}
