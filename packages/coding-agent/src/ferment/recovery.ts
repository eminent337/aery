import { logger } from "@aryee337/aery-utils";
import { FermentStore } from "./store.js";

/**
 * Compute where a stranded ferment was interrupted so a resumed run knows where
 * to continue. Returns the active phase id plus the first step still in
 * "running"/"pending" state (the resumption point), or undefined if none.
 */
function strandedPosition(ferment: {
	activePhaseId?: string;
	phases: Array<{
		id: string;
		steps: Array<{ id: string; status: string }>;
	}>;
}): { phaseId?: string; stepId?: string } | undefined {
	const phaseId = ferment.activePhaseId;
	if (!phaseId) return undefined;

	const phase = ferment.phases.find(p => p.id === phaseId);
	if (!phase) return undefined;

	// The step that was in flight when the orchestrator died is the one still
	// marked running; if none (e.g. crashed between steps), fall back to the
	// first not-yet-done step.
	const running = phase.steps.find(s => s.status === "running");
	const next = phase.steps.find(s => s.status === "pending");
	const stepId = running?.id ?? next?.id;

	if (!stepId) return undefined;
	return { phaseId, stepId };
}

/**
 * Recovers stranded ferments after a crash or unclean shutdown.
 * Any ferment with status "running" is marked as "paused" so it can
 * be manually resumed by the user, and a crash_recovery event records
 * the exact stranded position (active phase + in-flight step) so a
 * resumed run can continue where it left off.
 */
export function recoverStrandedFerments(storeArg?: FermentStore): void {
	let store: FermentStore | null = null;
	try {
		store = storeArg ?? FermentStore.open();
	} catch (err) {
		logger.error("Failed to open ferment store for crash recovery", { error: String(err) });
		return;
	}

	let runningFerments;
	try {
		runningFerments = store.listByStatus("running");
	} catch (err) {
		logger.error("Failed to list running ferments for crash recovery", { error: String(err) });
		return;
	}

	if (runningFerments.length === 0) {
		return;
	}

	logger.info(`Recovering ${runningFerments.length} stranded ferment(s)...`);

	for (const ferment of runningFerments) {
		// Per-row error handling: one ferment whose save() fails must not abort
		// recovery of the remaining stranded ferments.
		try {
			ferment.status = "paused";

			const position = strandedPosition(ferment);
			store.save(ferment, [
				{
					fermentId: ferment.id,
					eventType: "crash_recovery",
					eventData: {
						reason: "Ferment was stranded in running state due to orchestrator crash.",
						// Resume hint: where the run was interrupted, so a later
						// resume can continue from this phase/step.
						...(position ? { ...position } : {}),
					},
				},
			]);

			const where = position ? ` (phase ${position.phaseId}, step ${position.stepId})` : "";
			logger.warn(`Recovered stranded ferment ${ferment.id} (marked as paused)${where}.`);
		} catch (err) {
			logger.error(`Failed to recover stranded ferment ${ferment.id}`, { error: String(err) });
		}
	}
}
