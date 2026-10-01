import { describe, expect, test } from "bun:test";
import { type ClickTarget, HOVER_SLACK_PX, hoverNote, hoverTargetAt } from "../desktop-control";

/**
 * Hover awareness is the inverse of `target:` resolution: instead of "where do
 * I click to hit X?", it answers "if I click right now, what do I hit?".
 *
 * The failure this prevents is a click landing on a neighbouring control while
 * the model believes it hit the intended one — the exact "assumes coordinates"
 * behaviour that closed-loop positioning alone cannot catch, because the
 * coordinates can be perfectly correct and the LABEL still wrong.
 */

const box = (text: string, x: number, y: number, w: number, h: number): ClickTarget => ({
	text,
	x,
	y,
	w,
	h,
	confidence: 0.9,
});

const SEND = box("Send", 100, 100, 80, 30);
const CANCEL = box("Cancel", 200, 100, 80, 30);
const LABEL = box("Draft", 100, 200, 200, 20);
const POOL = [SEND, CANCEL, LABEL];

describe("hoverTargetAt — what is under the pointer", () => {
	test("names the box containing the point", () => {
		expect(hoverTargetAt({ x: 120, y: 110 }, POOL)?.text).toBe("Send");
		expect(hoverTargetAt({ x: 220, y: 110 }, POOL)?.text).toBe("Cancel");
	});

	test("returns null over empty space rather than guessing", () => {
		// The honest answer is the one that should stop a blind click.
		expect(hoverTargetAt({ x: 600, y: 400 }, POOL)).toBeNull();
	});

	test("treats box edges correctly (top-left in, far edges out)", () => {
		expect(hoverTargetAt({ x: 100, y: 100 }, POOL)?.text).toBe("Send");
		// SEND spans x 100..180, y 100..130. The last pixel inside is (179,129).
		expect(hoverTargetAt({ x: 179, y: 129 }, POOL)?.text).toBe("Send");
	});

	test("a diagonal near-miss never reports distance 0", () => {
		// (181,131) is 1px past BOTH far edges of SEND (x[100,180) y[100,130)).
		// Euclidean distance would round sqrt(2) to 1, but the per-axis gap
		// keeps it honest AND a point exactly on the corner — (180,130) — still
		// reads as a true 0 because that genuinely is the boundary.
		expect(hoverTargetAt({ x: 180, y: 130 }, [SEND])?.distancePx).toBe(0);
		const hit = hoverTargetAt({ x: 181, y: 131 }, [SEND]);
		expect(hit?.text).toBe("Send");
		expect(hit?.distancePx).toBe(1);
	});

	test("reports nothing once the gap exceeds the slack", () => {
		expect(hoverTargetAt({ x: 180 + HOVER_SLACK_PX + 1, y: 130 + HOVER_SLACK_PX + 1 }, [SEND])).toBeNull();
	});

	test("prefers the tightest containing box when boxes overlap", () => {
		// Dense windows nest boxes; naming the outermost one would say
		// "Draft" when the pointer is really on the button inside it.
		const outer = box("Panel", 0, 0, 400, 400);
		const inner = box("OK", 180, 180, 60, 30);
		expect(hoverTargetAt({ x: 200, y: 190 }, [outer, inner])?.text).toBe("OK");
	});

	test("a contained box beats a merely-near one", () => {
		const big = box("Background", 0, 0, 500, 500);
		const small = box("Chip", 300, 300, 40, 20);
		// Pointer is inside `big` but 2px outside `small`; containment wins.
		expect(hoverTargetAt({ x: 305, y: 322 }, [big, small])?.text).toBe("Background");
	});

	test("reports a near miss with its distance instead of claiming a hit", () => {
		const hit = hoverTargetAt({ x: 100 - 3, y: 110 }, [SEND]);
		expect(hit?.text).toBe("Send");
		expect(hit?.distancePx).toBe(3);
	});

	test("ignores boxes beyond the slack", () => {
		const far = box("Far", 0, 0, 10, 10);
		expect(hoverTargetAt({ x: 10 + HOVER_SLACK_PX + 1, y: 5 }, [far])).toBeNull();
		// Exactly at the slack still counts.
		expect(hoverTargetAt({ x: 10 + HOVER_SLACK_PX, y: 5 }, [far])?.text).toBe("Far");
	});

	test("an empty pool can never produce a hover", () => {
		expect(hoverTargetAt({ x: 120, y: 110 }, [])).toBeNull();
	});

	test("a generation filter hides targets from other readings", () => {
		// Stale glances must not name what the pointer is over: the boxes
		// describe a screen that may no longer exist.
		const stale = { ...SEND, gen: 4 } as ClickTarget & { gen: number };
		const fresh = { ...CANCEL, gen: 5 } as ClickTarget & { gen: number };
		expect(hoverTargetAt({ x: 120, y: 110 }, [stale, fresh], 5)).toBeNull();
		expect(hoverTargetAt({ x: 220, y: 110 }, [stale, fresh], 5)?.text).toBe("Cancel");
	});
});

describe("hoverNote — how hover is reported", () => {
	test("states the target plainly when resting on it", () => {
		expect(hoverNote({ text: "Send", distancePx: 0 })).toBe(' Pointer is over "Send".');
	});

	test("quantifies a near miss rather than implying a hit", () => {
		expect(hoverNote({ text: "Send", distancePx: 4 })).toBe(' Pointer is 4px from "Send".');
	});

	test("says so plainly when nothing is recognised", () => {
		expect(hoverNote(null)).toBe(" Pointer is over no recognised target.");
	});
});
