import { logger } from "@aryee337/aery-utils";
import { SessionStateStore } from "./state-store.js";

/**
 * Recovers any AgentSessions that were interrupted due to a crash.
 * This runs at startup and marks them as crashed so they can be resumed.
 */
export function recoverStrandedSessions(): void {
	try {
		const store = SessionStateStore.open();
		const runningSessions = store.listByStatus("running");

		if (runningSessions.length === 0) {
			return;
		}

		logger.info(`SessionRecovery: Found ${runningSessions.length} stranded session(s) to recover.`);

		for (const session of runningSessions) {
			logger.warn(`SessionRecovery: Marking stranded session ${session.sessionId} as crashed`);
			session.status = "crashed";
			store.save(session);
		}
	} catch (err) {
		logger.error("SessionRecovery: Failed to recover sessions", { error: String(err) });
	}
}
