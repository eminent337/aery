import { describe, expect, it } from "bun:test";
import { AmbientScheduler, type ScheduledItem } from "@aryee337/aery/ambient/scheduler";
import { EventBus } from "@aryee337/aery/utils/event-bus";

function createTestScheduler(): { scheduler: AmbientScheduler; bus: EventBus } {
	const bus = new EventBus();
	const scheduler = new AmbientScheduler("test-session", bus);
	return { scheduler, bus };
}

describe("ambient scheduler", () => {
	it("schedules items and sorts by due time then priority", () => {
		const { scheduler } = createTestScheduler();
		const now = Date.now();

		scheduler.schedule({
			id: "low-late",
			dueAt: now + 2000,
			priority: "low",
			sessionId: "test-session",
			message: "low late",
		});
		scheduler.schedule({
			id: "high-early",
			dueAt: now + 1000,
			priority: "high",
			sessionId: "test-session",
			message: "high early",
		});
		scheduler.schedule({
			id: "normal-early",
			dueAt: now + 1000,
			priority: "normal",
			sessionId: "test-session",
			message: "normal early",
		});

		const items = scheduler.items;
		expect(items[0]!.id).toBe("high-early");
		expect(items[1]!.id).toBe("normal-early");
		expect(items[2]!.id).toBe("low-late");
	});

	it("dueItems returns only items at or before now", () => {
		const { scheduler } = createTestScheduler();
		const now = Date.now();

		scheduler.schedule({
			id: "past",
			dueAt: now - 1000,
			priority: "normal",
			sessionId: "test-session",
			message: "past",
		});
		scheduler.schedule({
			id: "future",
			dueAt: now + 10000,
			priority: "normal",
			sessionId: "test-session",
			message: "future",
		});

		const due = scheduler.dueItems(now);
		expect(due.length).toBe(1);
		expect(due[0]!.id).toBe("past");
	});

	it("collectDue removes due items and emits events", () => {
		const { scheduler, bus } = createTestScheduler();
		const now = Date.now();
		const events: string[] = [];
		bus.on("ambient:item_due", (data: unknown) => {
			events.push((data as { item: ScheduledItem }).item.id);
		});

		scheduler.schedule({
			id: "due1",
			dueAt: now - 100,
			priority: "high",
			sessionId: "test-session",
			message: "due1",
		});
		scheduler.schedule({
			id: "due2",
			dueAt: now - 50,
			priority: "normal",
			sessionId: "test-session",
			message: "due2",
		});
		scheduler.schedule({
			id: "future",
			dueAt: now + 1000,
			priority: "low",
			sessionId: "test-session",
			message: "future",
		});

		const collected = scheduler.collectDue(now);
		expect(collected.length).toBe(2);
		expect(events.length).toBe(2);
		expect(scheduler.size).toBe(1);
	});

	it("cancel removes a specific item", () => {
		const { scheduler } = createTestScheduler();
		const now = Date.now();
		scheduler.schedule({
			id: "keep",
			dueAt: now + 1000,
			priority: "normal",
			sessionId: "test-session",
			message: "keep",
		});
		scheduler.schedule({
			id: "remove",
			dueAt: now + 2000,
			priority: "normal",
			sessionId: "test-session",
			message: "remove",
		});

		expect(scheduler.cancel("remove")).toBe(true);
		expect(scheduler.size).toBe(1);
		expect(scheduler.items[0]!.id).toBe("keep");
	});

	it("cancel returns false for unknown id", () => {
		const { scheduler } = createTestScheduler();
		expect(scheduler.cancel("unknown")).toBe(false);
	});

	it("clear empties the queue", () => {
		const { scheduler } = createTestScheduler();
		const now = Date.now();
		scheduler.schedule({ id: "a", dueAt: now + 1000, priority: "normal", sessionId: "test-session", message: "a" });
		scheduler.schedule({ id: "b", dueAt: now + 2000, priority: "normal", sessionId: "test-session", message: "b" });
		scheduler.clear();
		expect(scheduler.size).toBe(0);
	});
});
