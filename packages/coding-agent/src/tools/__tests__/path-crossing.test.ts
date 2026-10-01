import { describe, expect, test } from "bun:test";
import { type ClickTarget, pathCrossedNote, pathTargetsCrossed } from "../desktop-control";

/**
 * Path telemetry answers "what did the pointer travel OVER", which is the
 * part of a move a single end-point hover cannot report: a glide from the
 * toolbar to a button in the corner silently crosses a destructive control
 * on the way, and the model has no way to know that from the destination
 * alone.
 *
 * The point of this design is that it is FREE — the eased path is already
 * computed before the glide runs, and naming targets along it is a pure pool
 * lookup. These tests pin that behaviour, including the cases where staying
 * silent is the correct answer.
 */

const box = (text: string, x: number, y: number, w: number, h: number): ClickTarget => ({
	text,
	x,
	y,
	w,
	h,
	confidence: 0.9,
});

// A row of controls along y=100, which a left-to-right glide will cross.
const BAR = [box("New", 100, 100, 60, 24), box("Save", 200, 100, 60, 24), box("Delete", 300, 100, 60, 24)];
const FAR = box("Submit", 600, 400, 80, 30);

describe("pathTargetsCrossed — what the glide travels over", () => {
	test("reports controls crossed between two points in travel order", () => {
		const crossed = pathTargetsCrossed({ x: 120, y: 110 }, { x: 320, y: 110 }, BAR);
		expect(crossed.map(c => c.text)).toEqual(["New", "Save", "Delete"]);
	});

	test("includes the destination control", () => {
		const crossed = pathTargetsCrossed({ x: 120, y: 110 }, { x: 320, y: 110 }, BAR);
		expect(crossed[crossed.length - 1]?.text).toBe("Delete");
	});

	test("reports nothing when the path touches no control", () => {
		// Silence is the right answer here: "passed over nothing" is noise.
		expect(pathTargetsCrossed({ x: 500, y: 300 }, { x: 560, y: 340 }, BAR)).toEqual([]);
	});

	test("never repeats a control it already reported", () => {
		// The eased path can pass over the same box at several samples.
		const crossed = pathTargetsCrossed({ x: 110, y: 110 }, { x: 340, y: 110 }, BAR);
		const texts = crossed.map(c => c.text);
		expect(new Set(texts).size).toBe(texts.length);
	});

	test("keeps two distinct controls that share a label", () => {
		// De-duplication is by label AND position, so two "Save" buttons on
		// opposite sides of the window both appear.
		const two = [box("Save", 100, 100, 60, 24), box("Save", 600, 100, 60, 24)];
		const crossed = pathTargetsCrossed({ x: 120, y: 110 }, { x: 620, y: 110 }, two);
		expect(crossed).toHaveLength(2);
	});

	test("an empty pool can never produce crossings", () => {
		expect(pathTargetsCrossed({ x: 120, y: 110 }, { x: 320, y: 110 }, [])).toEqual([]);
	});

	test("a generation filter hides targets from other readings", () => {
		const stale = { ...BAR[0]!, gen: 4 } as ClickTarget & { gen: number };
		const fresh = { ...BAR[2]!, gen: 5 } as ClickTarget & { gen: number };
		expect(pathTargetsCrossed({ x: 120, y: 110 }, { x: 320, y: 110 }, [stale], 5)).toEqual([]);
		expect(pathTargetsCrossed({ x: 120, y: 110 }, { x: 320, y: 110 }, [fresh], 5).map(c => c.text)).toEqual([
			"Delete",
		]);
	});

	test("a path away from every control reports the destination only if it lands on one", () => {
		const crossed = pathTargetsCrossed({ x: 120, y: 110 }, { x: 620, y: 410 }, [FAR]);
		expect(crossed.map(c => c.text)).toEqual(["Submit"]);
	});
});

describe("pathCrossedNote — how crossings are reported", () => {
	test("lists the crossed controls in order", () => {
		expect(pathCrossedNote([{ text: "New" }, { text: "Save" }])).toBe(' Path crossed: "New" → "Save".');
	});

	test("says nothing when nothing was crossed", () => {
		expect(pathCrossedNote([])).toBe("");
	});

	test("caps a long list so a dense window cannot flood the report", () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ text: `B${i}` }));
		const note = pathCrossedNote(many, 3);
		expect(note).toContain('"B0" → "B1" → "B2"');
		expect(note).toContain("+7 more");
		expect(note).not.toContain('"B3"');
	});
});
