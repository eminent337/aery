import { logger } from "@aryee337/aery-utils";
import { SwarmStore, type PersistedSwarm } from "./store.js";
import { SwarmScheduler } from "./scheduler.js";

/**
 * Recovers and restarts any Swarms that were interrupted due to a crash.
 * This runs at startup and resumes the orchestrator logic for active swarms.
 */
export async function startSwarmWatchdog(ctx: any): Promise<void> {
	try {
		const store = SwarmStore.open();
		const activeSwarms = store.listActive();

		if (activeSwarms.length === 0) {
			return;
		}

		logger.info(`SwarmWatchdog: Found ${activeSwarms.length} active swarm(s) to recover.`);

		for (const swarm of activeSwarms) {
			logger.info(`SwarmWatchdog: Restarting swarm ${swarm.id} ("${swarm.workflow.name}")`);
			
			// Reconstruct scheduler with the persisted workflow
			const scheduler = new SwarmScheduler(swarm.workflow);
			
			// Restore the precise task states (pending, completed, etc)
			for (const [taskId, state] of Object.entries(swarm.taskStates)) {
				if (scheduler.taskStates.has(taskId)) {
					scheduler.taskStates.set(taskId, state);
				}
			}

			// Fire and forget execution; it will update the store as it progresses
			// (Note: in a full implementation, the scheduler itself should hook into the SwarmStore
			// to persist state changes, just like FermentStore does).
			scheduler.execute(ctx).then(() => {
				swarm.status = "completed";
				store.save(swarm);
				logger.info(`SwarmWatchdog: Recovered swarm ${swarm.id} completed successfully.`);
			}).catch((err) => {
				swarm.status = "failed";
				store.save(swarm);
				logger.error(`SwarmWatchdog: Recovered swarm ${swarm.id} failed`, { error: String(err) });
			});
		}
	} catch (err) {
		logger.error("SwarmWatchdog: Failed to recover swarms", { error: String(err) });
	}
}
