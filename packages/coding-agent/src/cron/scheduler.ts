/**
 * Cron Scheduler
 * 
 * Periodically checks for due jobs and executes them.
 */

import { Database } from "bun:sqlite";
import { getAgentDbPath } from "@aryee337/aery-utils";
import { createCronJobStore } from "./store.js";
import type {
	CronEvent,
	CronJob,
	CronJobStore,
	CronSchedulerHost,
} from "./types.js";
/** Default check interval in milliseconds */
const DEFAULT_CHECK_INTERVAL_MS = 30_000; // 30 seconds

export class CronScheduler {
	readonly #host: CronSchedulerHost;
	#intervalMs: number;
	#running: boolean;
	#timerId: ReturnType<typeof setInterval> | null;

	constructor(host: CronSchedulerHost, options?: { checkIntervalMs?: number }) {
		this.#host = host;
		this.#intervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
		this.#running = false;
		this.#timerId = null;
	}
	get store(): CronJobStore {
		return this.#host.store;
	}

	/**
	 * Start the scheduler.
	 */
	start(): void {
		if (this.#running) {
			return;
		}
		this.#running = true;
		this.#timerId = setInterval(() => this.#tick(), this.#intervalMs);
		this.#host.emit({ type: "scheduler_tick", jobsChecked: 0, jobsExecuted: 0 });
	}

	/**
	 * Stop the scheduler.
	 */
	stop(): void {
		this.#running = false;
		if (this.#timerId !== null) {
			clearInterval(this.#timerId);
			this.#timerId = null;
		}
	}

	/**
	 * Get current running state.
	 */
	get isRunning(): boolean {
		return this.#running;
	}

	/**
	 * Execute due jobs.
	 */
	async executeDue(): Promise<void> {
		const jobs = await this.#host.store.findDue();
		let executed = 0;

		for (const job of jobs) {
			await this.#executeJob(job);
			executed++;
		}

		this.#host.emit({ type: "scheduler_tick", jobsChecked: jobs.length, jobsExecuted: executed });
	}

	/**
	 * Execute a single job.
	 */
	async #executeJob(job: CronJob): Promise<void> {
		this.#host.emit({ type: "job_started", job });

		const startTime = this.#host.now();
		try {
			await this.#host.executeSession(job.sessionId, job.deliveryMode);
			
			// Update last run and next run
			const now = this.#host.now();
			await this.#host.store.update(job.id, {
				lastRunAt: now,
				updatedAt: now,
			});

			this.#host.emit({ type: "job_completed", job, durationMs: now - startTime });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.#host.emit({ type: "job_failed", job, error });
		}
	}
	async #tick(): Promise<void> {
		if (!this.#running) return;
		try {
			await this.executeDue();
		} catch {
			// Ignore tick errors
		}
	}
}
/**
 * Create a cron scheduler instance.
 */
export function createCronScheduler(host: CronSchedulerHost): CronScheduler {
	return new CronScheduler(host);
}
let globalCronSchedulerInstance: CronScheduler | undefined;
/**
 * Get or initialize the global cron scheduler singleton.
 */
export function getGlobalCronScheduler(): CronScheduler {
	if (!globalCronSchedulerInstance) {
		const db = new Database(getAgentDbPath());
		const store = createCronJobStore(db);
		const host: CronSchedulerHost = {
			store,
			now: () => Date.now(),
			emit: (_event) => {},
			executeSession: async (_sessionId, _deliveryMode) => {},
		};
		globalCronSchedulerInstance = new CronScheduler(host);
		globalCronSchedulerInstance.start();
	}
	return globalCronSchedulerInstance;
}