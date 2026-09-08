/**
 * Schedule tool — queue a future ambient task delivered to the interactive
 * session once it is idle.
 *
 * Ported from jcode upstream (crates/jcode-app-core/src/tool/ambient.rs
 * ScheduleTool). Creates a ScheduledItem with a future due time and priority.
 * A per-session poller holds due items until the session's delivery target
 * reports that it can accept a hidden injected turn, then hands the item over.
 * Items are never dropped just because the session was busy at the due instant
 * — they stay queued and are retried on the next poll tick.
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import { AmbientScheduler, type ScheduledItem, type SchedulePriority } from "../ambient/scheduler";
import type { EventBus } from "../utils/event-bus";
import type { ToolSession } from "./index";

const scheduleSchema = z.object({
	message: z.string().describe("Message content for the scheduled task"),
	dueAt: z.number().int().describe("Unix timestamp (ms) for when the task should fire"),
	priority: z.enum(["low", "normal", "high"]).optional().describe("Task priority (default normal)"),
	metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
});

export type ScheduleToolParams = z.infer<typeof scheduleSchema>;

const PRIORITY_SET: ReadonlySet<string> = new Set(["low", "normal", "high"]);

type AmbientPollerHandle = ReturnType<typeof setInterval>;

/** Poll cadence for due items. */
const POLL_INTERVAL_MS = 5_000;

/** How long a due item may wait for an idle session before being dropped. */
const AMBIENT_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * A delivery target (the interactive UI) attached to a session. The poller
 * only hands a due item over when `canDeliver()` reports the session is ready.
 */
export interface AmbientDeliveryTarget {
	/** Whether the session can accept a hidden injected turn right now. */
	canDeliver(): boolean;
	/** Deliver the due item as a hidden injected turn. */
	deliver(item: ScheduledItem): void;
}

type SessionAmbientState = {
	scheduler: AmbientScheduler;
	poller: AmbientPollerHandle;
};

/** Global per-session scheduler state, persists across tool calls. */
const sessionAmbient = new Map<string, SessionAmbientState>();

/** Delivery targets registered by interactive UIs, keyed by session id. */
const sessionTargets = new Map<string, AmbientDeliveryTarget>();

/** Poll for due items and hand them to the session when it is idle. */
function tick(sessionId: string): void {
	const state = sessionAmbient.get(sessionId);
	if (!state) return;
	const target = sessionTargets.get(sessionId);
	const now = Date.now();
	for (const item of [...state.scheduler.items]) {
		if (item.dueAt > now) continue;
		if (!target || !target.canDeliver()) {
			// Busy or unattached: keep the item queued and retry next tick,
			// but do not hold a due item forever.
			if (now - item.dueAt > AMBIENT_STALE_AFTER_MS) {
				state.scheduler.cancel(item.id);
				console.warn(`[ambient] dropped stale scheduled task ${item.id} (session never became idle)`);
			}
			continue;
		}
		state.scheduler.cancel(item.id);
		try {
			target.deliver(item);
		} catch (error) {
			console.error(`[ambient] delivery failed for scheduled task ${item.id}`, error);
		}
	}
}

/**
 * Attach (or replace) the delivery target for a session. Returns a dispose
 * function; call it when the session UI tears down.
 */
export function registerAmbientDeliveryTarget(
	sessionId: string,
	target: AmbientDeliveryTarget,
): () => void {
	sessionTargets.set(sessionId, target);
	return () => {
		if (sessionTargets.get(sessionId) === target) {
			sessionTargets.delete(sessionId);
		}
	};
}

/** Ensure a scheduler + poller exist for the session and return its scheduler. */
function getOrCreateState(sessionId: string, bus: EventBus): AmbientScheduler {
	let state = sessionAmbient.get(sessionId);
	if (!state) {
		state = {
			scheduler: new AmbientScheduler(sessionId, bus),
			poller: setInterval(() => tick(sessionId), POLL_INTERVAL_MS),
		};
		sessionAmbient.set(sessionId, state);
	}
	return state.scheduler;
}

export class ScheduleTool implements AgentTool<typeof scheduleSchema> {
	readonly name = "schedule";
	readonly approval = "read" as const;
	readonly label = "Schedule";
	readonly description =
		"Queue a future ambient task. The task fires at `dueAt` (unix ms) and is delivered to this session as a hidden turn once the session is idle. Use for deferred follow-ups, reminders, and proactive background work.";
	readonly parameters = scheduleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Queue a future ambient task with priority";

	constructor(private readonly scheduler: AmbientScheduler) {}

	static createIf(session: ToolSession): ScheduleTool | null {
		const bus = session.eventBus;
		if (!bus) return null;
		const sessionId = session.getSessionId?.() ?? "default";
		return new ScheduleTool(getOrCreateState(sessionId, bus));
	}

	async execute(_id: string, params: ScheduleToolParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const priority: SchedulePriority = PRIORITY_SET.has(params.priority ?? "") ? params.priority! : "normal";
			const item = this.scheduler.schedule({
				id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				dueAt: params.dueAt,
				priority,
				sessionId: this.scheduler.sessionId,
				message: params.message,
				metadata: params.metadata,
			});

			return {
				content: [
					{
						type: "text",
						text: `Scheduled task ${item.id} at ${new Date(item.dueAt).toISOString()} (${item.priority}). Scheduler has ${this.scheduler.size} item(s).`,
					},
				],
				details: { id: item.id, dueAt: item.dueAt, priority: item.priority, queueSize: this.scheduler.size },
			};
		});
	}
}
