import { logger } from "@aryee337/aery-utils";
import type { AgentSession } from "../session/agent-session";

const IDLE_TRIM_AFTER_MS = 60 * 1000;
const RETENTION_CHECK_INTERVAL_MS = 30 * 1000;
const IDLE_RETRIM_INTERVAL_MS = 300 * 1000;

export class IdleHeapRelease {
	#lastActivityTime: number = Date.now();
	#trimmedThisIdlePeriod = false;
	#lastIdleTrimTime = 0;
	#timer: ReturnType<typeof setInterval> | null = null;
	#session: AgentSession;

	constructor(session: AgentSession) {
		this.#session = session;
	}

	/**
	 * Start the idle heap release watchdog.
	 */
	start(): void {
		if (this.#timer) return;

		// Listen to all agent session events as a sign of activity
		this.#session.subscribe(() => this.bumpActivity());

		this.#timer = setInterval(() => {
			this.#checkIdleState();
		}, 10_000); // Check every 10 seconds
		this.#timer.unref(); // Don't keep the event loop alive just for this
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	/**
	 * Mark that the application is currently active.
	 */
	bumpActivity(): void {
		this.#lastActivityTime = Date.now();
		this.#trimmedThisIdlePeriod = false;
	}

	#checkIdleState(): void {
		const now = Date.now();
		const timeSinceActivity = now - this.#lastActivityTime;

		const isIdle = timeSinceActivity >= IDLE_TRIM_AFTER_MS;

		if (!isIdle) {
			this.#trimmedThisIdlePeriod = false;
			return;
		}

		// Re-trim cadence while a client stays idle.
		// Heartbeats and remote snapshots can keep churning small allocations on idle clients.
		const periodicRetrimDue = this.#lastIdleTrimTime === 0 || now - this.#lastIdleTrimTime >= IDLE_RETRIM_INTERVAL_MS;

		if (this.#trimmedThisIdlePeriod && !periodicRetrimDue) {
			return;
		}

		logger.debug("IdleHeapRelease: Triggering garbage collection (App is idle)");

		// In Bun, we can force a garbage collection
		if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
			Bun.gc(true); // synchronous GC
		} else if (global.gc) {
			global.gc();
		}

		this.#trimmedThisIdlePeriod = true;
		this.#lastIdleTrimTime = now;
	}
}
