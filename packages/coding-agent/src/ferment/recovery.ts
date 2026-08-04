import { logger } from "@aryee337/aery-utils";
import { FermentStore } from "./store.js";

/**
 * Recovers stranded ferments after a crash or unclean shutdown.
 * Any ferment with status "running" is marked as "paused" so it can
 * be manually resumed by the user, and an event is logged.
 */
export function recoverStrandedFerments(): void {
	try {
		const store = FermentStore.open();
		const runningFerments = store.listByStatus("running");

		if (runningFerments.length === 0) {
			return;
		}

		logger.info(`Recovering ${runningFerments.length} stranded ferment(s)...`);

		for (const ferment of runningFerments) {
			ferment.status = "paused";

			store.save(ferment, [
				{
					fermentId: ferment.id,
					eventType: "crash_recovery",
					eventData: { reason: "Ferment was stranded in running state due to orchestrator crash." },
				},
			]);

			logger.warn(`Recovered stranded ferment ${ferment.id} (marked as paused).`);
		}
	} catch (err) {
		logger.error("Failed to recover stranded ferments", { error: String(err) });
	}
}
