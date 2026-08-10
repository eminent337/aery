/**
 * Cron System Types
 *
 * Scheduled session execution with persistence and delivery modes.
 */

/**
 * Schedule format: "every 5m", "every 1h", "0 9 * * *" (cron)
 */
export type CronSchedule = string;

/**
 * Delivery mode for cron job execution.
 */
export type CronDeliveryMode = "steer" | "follow_up";

/**
 * Cron job definition.
 */
export interface CronJob {
	/** Unique identifier */
	id: string;
	/** Schedule expression */
	schedule: CronSchedule;
	/** Session ID to execute */
	sessionId: string;
	/** Delivery mode */
	deliveryMode: CronDeliveryMode;
	/** Job description */
	description?: string;
	/** Whether enabled */
	enabled: boolean;
	/** Last execution time */
	lastRunAt?: number;
	/** Next scheduled execution time */
	nextRunAt?: number;
	/** Creation timestamp */
	createdAt: number;
	/** Last update timestamp */
	updatedAt: number;
}

/**
 * Cron job store interface.
 */
export interface CronJobStore {
	/** Get all jobs */
	list(): Promise<CronJob[]>;
	/** Get a job by ID */
	get(id: string): Promise<CronJob | undefined>;
	/** Create a new job */
	create(job: Omit<CronJob, "id" | "createdAt" | "updatedAt" | "nextRunAt">): Promise<CronJob>;
	/** Update a job */
	update(id: string, updates: Partial<CronJob>): Promise<CronJob | undefined>;
	/** Delete a job */
	delete(id: string): Promise<boolean>;
	/** Find jobs due for execution */
	findDue(beforeMs?: number): Promise<CronJob[]>;
}

/**
 * Schedule parser result.
 */
export interface ParsedSchedule {
	/** Next execution timestamp */
	nextRunAt: number;
	/** Human-readable description */
	description: string;
}

/**
 * Cron event types.
 */
export type CronEvent =
	| { type: "job_started"; job: CronJob }
	| { type: "job_completed"; job: CronJob; durationMs: number }
	| { type: "job_failed"; job: CronJob; error: string }
	| { type: "scheduler_tick"; jobsChecked: number; jobsExecuted: number };

/**
 * Cron scheduler host interface.
 */
export interface CronSchedulerHost {
	/** Execute a session */
	executeSession(sessionId: string, deliveryMode: CronDeliveryMode): Promise<void>;
	/** Emit an event */
	emit(event: CronEvent): void;
	/** Get current time */
	now(): number;
	/** Job store */
	store: CronJobStore;
}
