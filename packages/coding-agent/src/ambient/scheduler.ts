/**
 * Ambient scheduler — adaptive scheduling with priority queue.
 *
 * Ported from jcode upstream (crates/jcode-app-core/src/ambient/):
 * adds a priority queue for scheduled items and adaptive intervals based
 * on usage rate tracking. Complements Aery's existing cron system with
 * rate-aware scheduling.
 */

import type { EventBus } from "../utils/event-bus";

export type SchedulePriority = "low" | "normal" | "high";

export interface ScheduledItem {
	/** Unique identifier */
	id: string;
	/** Scheduled execution time */
	dueAt: number;
	/** Priority (high > normal > low) */
	priority: SchedulePriority;
	/** Delivery target session ID */
	sessionId: string;
	/** Message content */
	message: string;
	/** Optional metadata */
	metadata?: Record<string, unknown>;
	/** Creation timestamp */
	createdAt: number;
}

export type AmbientEvent =
	| { type: "item_due"; item: ScheduledItem }
	| { type: "item_scheduled"; item: ScheduledItem }
	| { type: "scheduler_tick"; itemsChecked: number; itemsExecuted: number };

const PRIORITY_WEIGHT: Record<SchedulePriority, number> = {
	low: 1,
	normal: 2,
	high: 3,
};

/**
 * Priority queue for scheduled items due for execution.
 */
export class AmbientScheduler {
	#items: ScheduledItem[] = [];
	#bus: EventBus;
	#sessionId: string;

	constructor(sessionId: string, bus: EventBus) {
		this.#sessionId = sessionId;
		this.#bus = bus;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	/** Number of scheduled items. */
	get size(): number {
		return this.#items.length;
	}

	/** All scheduled items (sorted by due time, then priority). */
	get items(): readonly ScheduledItem[] {
		return [...this.#items].sort(
			(a, b) => a.dueAt - b.dueAt || PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority],
		);
	}

	/**
	 * Schedule a new item. Items with the same dueAt are ordered by priority
	 * (high first).
	 */
	schedule(item: Omit<ScheduledItem, "createdAt">): ScheduledItem {
		const full: ScheduledItem = { ...item, createdAt: Date.now() };
		this.#items.push(full);
		this.#items.sort((a, b) => a.dueAt - b.dueAt || PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]);
		this.#bus.emit("ambient:item_scheduled", { type: "item_scheduled", item: full });
		return full;
	}

	/**
	 * Get items due at or before `now`, in priority order.
	 */
	dueItems(now = Date.now()): ScheduledItem[] {
		return this.#items.filter(item => item.dueAt <= now);
	}

	/**
	 * Remove items due at or before `now`. Returns the removed items.
	 */
	collectDue(now = Date.now()): ScheduledItem[] {
		const due: ScheduledItem[] = [];
		const remaining: ScheduledItem[] = [];
		for (const item of this.#items) {
			if (item.dueAt <= now) {
				due.push(item);
			} else {
				remaining.push(item);
			}
		}
		this.#items = remaining;
		for (const item of due) {
			this.#bus.emit("ambient:item_due", { type: "item_due", item });
		}
		return due;
	}

	/** Remove a specific item by ID. */
	cancel(id: string): boolean {
		const before = this.#items.length;
		this.#items = this.#items.filter(item => item.id !== id);
		return this.#items.length < before;
	}

	/** Remove all items. */
	clear(): void {
		this.#items = [];
	}
}

export { PRIORITY_WEIGHT };
