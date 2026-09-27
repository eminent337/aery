import { describe, expect, test } from "bun:test";
import { injectionQueueDepth, withInjectionQueue } from "../desktop-control";

/** The D003 queue: same-turn presses must run ONE AT A TIME, in the order
 *  they were issued, so "click the field, then type into it" behaves as
 *  written even though the agent loop dispatches both in parallel.
 *
 *  The property that matters is mutual exclusion + FIFO: presses must never
 *  overlap (that was the whole race), and the order must match submission
 *  order. A throwing press must also release its slot, or one failure would
 *  deadlock every later press in the session.
 */
describe("injection queue (D003: same-turn presses keep submission order)", () => {
	test("presses never overlap", async () => {
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			[1, 2, 3, 4, 5].map(() =>
				withInjectionQueue(async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise(r => setTimeout(r, 5));
					active--;
				}),
			),
		);
		expect(maxActive).toBe(1);
	});

	test("order is submission order, not completion order", async () => {
		const order: number[] = [];
		await Promise.all(
			[10, 20, 30, 40].map(n =>
				withInjectionQueue(async () => {
					// First-in-sleeps-longest: a naive parallel run would
					// finish in reverse, so this proves serialization AND
					// FIFO together.
					await new Promise(r => setTimeout(r, n === 10 ? 30 : 1));
					order.push(n);
				}),
			),
		);
		expect(order).toEqual([10, 20, 30, 40]);
	});

	test("a rejected press releases its slot — no deadlock", async () => {
		const boom = withInjectionQueue(async () => {
			throw new Error("injection failed");
		});
		await expect(boom).rejects.toThrow("injection failed");
		// The chain must be usable again immediately.
		const after = await withInjectionQueue(async () => "still works");
		expect(after).toBe("still works");
	});

	test("one failure in the middle does not reorder or skip the rest", async () => {
		const order: string[] = [];
		await Promise.all(
			["a", "b", "c"].map(n =>
				withInjectionQueue(async () => {
					if (n === "b") throw new Error("b failed");
					order.push(n);
				}).catch(() => {}),
			),
		);
		expect(order).toEqual(["a", "c"]);
	});

	test("depth reports queued work and drains to zero", async () => {
		expect(injectionQueueDepth()).toBe(0);
		const first = withInjectionQueue(async () => {
			await new Promise(r => setTimeout(r, 20));
			return injectionQueueDepth();
		});
		// These two pile up behind the first.
		const rest = Promise.all([
			withInjectionQueue(async () => injectionQueueDepth()),
			withInjectionQueue(async () => injectionQueueDepth()),
		]);
		// While the first holds the slot, depth counts all three.
		expect(injectionQueueDepth()).toBe(3);
		await first;
		const depths = await rest;
		// Each observer sees the remaining queue drain, never more than 3.
		for (const d of depths) expect(d).toBeLessThanOrEqual(3);
		expect(injectionQueueDepth()).toBe(0);
	});

	test("a slow press does not starve a later one (fairness)", async () => {
		const order: string[] = [];
		const slow = withInjectionQueue(async () => {
			await new Promise(r => setTimeout(r, 25));
			order.push("slow");
		});
		const fast = withInjectionQueue(async () => {
			order.push("fast");
		});
		await Promise.all([slow, fast]);
		// The fast one waited its turn rather than jumping the slow one.
		expect(order).toEqual(["slow", "fast"]);
	});
});
