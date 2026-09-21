import { describe, expect, test } from "bun:test";
import {
	CLICK_CHOREOGRAPHY,
	DEFAULT_MOTION_CONFIG,
	DRAG_CHOREOGRAPHY,
	clickPath,
	dragPath,
	type Rng,
	windMousePath,
} from "../mouse-motion";

/** Deterministic RNG (mulberry32) so path structure is reproducible in tests. */
function seeded(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CFG = DEFAULT_MOTION_CONFIG;

describe("windMousePath structure", () => {
	test("lands exactly on target (a click must never drift)", () => {
		for (const seed of [1, 2, 3, 42, 777]) {
			const p = windMousePath(100, 120, 900, 640, CFG, seeded(seed));
			const last = p.steps[p.steps.length - 1];
			expect(last.x).toBe(900);
			expect(last.y).toBe(640);
		}
	});

	test("is a real multi-step path, not a teleport", () => {
		const p = windMousePath(20, 20, 900, 700, CFG, seeded(7));
		expect(p.steps.length).toBeGreaterThanOrEqual(8);
	});

	test("bounds every step by maxStep (with rounding slack)", () => {
		const p = windMousePath(20, 20, 1500, 880, CFG, seeded(11));
		for (let i = 1; i < p.steps.length; i++) {
			const d = Math.hypot(p.steps[i].x - p.steps[i - 1].x, p.steps[i].y - p.steps[i - 1].y);
			expect(d).toBeLessThanOrEqual(CFG.maxStep + 2);
		}
	});

	test("curves: intermediate points are not collinear for long moves", () => {
		const p = windMousePath(10, 450, 1590, 450, CFG, seeded(3));
		const mid = p.steps[Math.floor(p.steps.length / 2)];
		// A straight horizontal line keeps y=450 exactly; WindMouse bows off it.
		expect(Math.abs(mid.y - 450)).toBeGreaterThan(0.5);
	});

	test("distance-proportional duration inside the human band", () => {
		const near = windMousePath(10, 10, 60, 30, CFG, seeded(5));
		const far = windMousePath(10, 10, 1580, 880, CFG, seeded(5));
		expect(near.totalMs).toBeGreaterThanOrEqual(CFG.minDurationMs);
		expect(far.totalMs).toBeLessThanOrEqual(CFG.maxDurationMs);
		expect(far.totalMs).toBeGreaterThanOrEqual(near.totalMs);
	});

	test("path covers distance progressively: no long stall, no long jump", () => {
		const p = windMousePath(5, 450, 1595, 450, CFG, seeded(13));
		const n = p.steps.length;
		expect(n).toBeGreaterThan(12);
		// Every decile of the path must advance a real share of the journey:
		// no decile stalls (<2% of the distance) and none teleports (>35%).
		// This is the observable that matters on a mirror — steady progress
		// from press point to release, never hesitation nor a yank.
		for (let i = 0; i < 10; i++) {
			const a = p.steps[Math.floor((n * i) / 10)];
			const b = p.steps[Math.min(n - 1, Math.floor((n * (i + 1)) / 10))];
			const share = Math.hypot(b.x - a.x, b.y - a.y) / p.distance;
			expect(share).toBeGreaterThan(0.02);
			expect(share).toBeLessThan(0.35);
		}
	});

	test("tiny moves take a short near-straight path", () => {
		const p = windMousePath(100, 100, 118, 112, CFG, seeded(9));
		expect(p.steps.length).toBeLessThanOrEqual(8);
		const last = p.steps[p.steps.length - 1];
		expect([last.x, last.y]).toEqual([118, 112]);
		expect(last.waitMs).toBeGreaterThan(0);
	});

	test("zero-length move yields one settle step (no empty path)", () => {
		const p = windMousePath(50, 50, 50, 50, CFG, seeded(1));
		expect(p.steps).toHaveLength(1);
		expect(p.steps[0]).toEqual({ x: 50, y: 50, waitMs: CFG.minWait });
		expect(p.maxStepPx).toBe(0);
	});

	test("is deterministic for a fixed seed", () => {
		const a = windMousePath(0, 0, 800, 600, CFG, seeded(99));
		const b = windMousePath(0, 0, 800, 600, CFG, seeded(99));
		expect(a.steps).toEqual(b.steps);
		expect(a.totalMs).toBe(b.totalMs);
	});

	test("never produces a non-positive wait", () => {
		const p = windMousePath(0, 0, 1590, 890, CFG, seeded(21));
		for (const s of p.steps) expect(s.waitMs).toBeGreaterThan(0);
	});

	test("clickPath stays snappier than a full sweep", () => {
		const sweep = windMousePath(0, 0, 1590, 890, CFG, seeded(4));
		const click = clickPath(0, 0, 1590, 890, CFG, seeded(4));
		expect(click.totalMs).toBeLessThanOrEqual(420);
		expect(click.totalMs).toBeLessThanOrEqual(sweep.totalMs);
	});

	test("click choreography pauses are present and sane", () => {
		expect(CLICK_CHOREOGRAPHY.settleMs).toBeGreaterThan(0);
		expect(CLICK_CHOREOGRAPHY.holdMs).toBeGreaterThan(0);
		expect(CLICK_CHOREOGRAPHY.settleMs).toBeLessThan(400);
	});

	test("dragPath lands exactly on the release point (no dropped tail)", () => {
		for (const seed of [1, 2, 3, 42, 777]) {
			const p = dragPath(100, 120, 900, 640, CFG, seeded(seed));
			const last = p.steps[p.steps.length - 1];
			expect(last.x).toBe(900);
			expect(last.y).toBe(640);
		}
	});

	test("dragPath keeps the full steady band (steady beats snappy for selects)", () => {
		const sweep = windMousePath(0, 0, 1590, 890, CFG, seeded(4));
		const drag = dragPath(0, 0, 1590, 890, CFG, seeded(4));
		expect(drag.totalMs).toBe(sweep.totalMs);
		expect(drag.totalMs).toBeLessThanOrEqual(CFG.maxDurationMs);
	});

	test("drag choreography pauses are present and sane", () => {
		expect(DRAG_CHOREOGRAPHY.settleMs).toBeGreaterThan(0);
		expect(DRAG_CHOREOGRAPHY.pressHoldMs).toBeGreaterThan(0);
		expect(DRAG_CHOREOGRAPHY.endHoldMs).toBeGreaterThan(0);
		expect(DRAG_CHOREOGRAPHY.settleMs).toBeLessThan(400);
		expect(DRAG_CHOREOGRAPHY.endHoldMs).toBeLessThan(400);
	});
});
