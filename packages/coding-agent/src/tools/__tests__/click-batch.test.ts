import { describe, expect, test } from "bun:test";
import {
	BATCH_DEFAULT_SETTLE_MS,
	BATCH_MAX_STEPS,
	batchFailureKind,
	DesktopControlTool,
	type PlannedClickStep,
	planClickBatch,
	rememberClickTargets,
	resolveClickTarget,
	runClickBatch,
} from "../desktop-control";

const FRAME = { scaledW: 1280, scaledH: 800, kind: "window", address: "win1" };
const schema = new DesktopControlTool().parameters;
/** A resolver over a fixed word→point table, so a step's fate is explicit. */
const table = (words: Record<string, { x: number; y: number }>) => (w: string) => words[w] ?? null;

describe("batch failure classification (drives the abort advice)", () => {
	test("races with the world are transient — the same retry can work", () => {
		for (const code of [
			"glide_in_flight",
			"frame_stale",
			"observation_stale",
			"observation_superseded",
			"observation_mismatch",
			"observation_geometry_mismatch",
			"focus_lost",
			"input_failed",
		]) {
			expect(batchFailureKind(code)).toBe("transient");
		}
	});
	test("facts about the request are permanent — retrying unchanged never works", () => {
		for (const code of [
			"target_not_found",
			"out_of_bounds",
			"missing_xy",
			"no_frame",
			"guardrail_refusal",
			"batch_too_long",
			"empty_batch",
		]) {
			expect(batchFailureKind(code)).toBe("permanent");
		}
	});
	test("an unknown or absent code fails closed to permanent", () => {
		expect(batchFailureKind("something_new")).toBe("permanent");
		expect(batchFailureKind(undefined)).toBe("permanent");
	});
});

describe("planClickBatch (pure: validates the whole batch before anything is injected)", () => {
	test("plans every step in order, defaulting button/count/settle", () => {
		const plan = planClickBatch(
			[
				{ x: 10, y: 20 },
				{ x: 30, y: 40 },
				{ x: 50, y: 60 },
			],
			{
				frame: FRAME,
				focusedAddress: "win1",
				resolve: table({}),
			},
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.planned.map(p => [p.tx, p.ty])).toEqual([
			[10, 20],
			[30, 40],
			[50, 60],
		]);
		expect(plan.planned.map(p => p.index)).toEqual([0, 1, 2]);
		for (const p of plan.planned) {
			expect(p.button).toBe("left");
			expect(p.count).toBe(1);
			expect(p.settleMs).toBe(BATCH_DEFAULT_SETTLE_MS);
		}
	});

	test("per-step overrides survive (button, count, settleMs)", () => {
		const plan = planClickBatch(
			[
				{ x: 10, y: 20, button: "right" },
				{ x: 30, y: 40, count: 2 },
				{ x: 50, y: 60, settleMs: 800 },
			],
			{ frame: FRAME, focusedAddress: "win1", resolve: table({}) },
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.planned[0]!.button).toBe("right");
		expect(plan.planned[1]!.count).toBe(2);
		expect(plan.planned[2]!.settleMs).toBe(800);
	});

	test("word targets resolve to their centre and record the anchor", () => {
		const plan = planClickBatch([{ target: "Compose" }, { target: "Drafts" }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: table({ Compose: { x: 160, y: 215 }, Drafts: { x: 400, y: 90 } }),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.planned[0]).toMatchObject({ tx: 160, ty: 215, target: "Compose" });
		expect(plan.planned[1]).toMatchObject({ tx: 400, ty: 90, target: "Drafts" });
	});

	// The load-bearing property: a batch validated up front must be able to
	// refuse a LATE step without having injected the earlier ones. A single
	// click has no earlier step, so this is the safety a batch must earn.
	test("a refused step 3 aborts the WHOLE batch — plannedBefore proves step 1 was never injected", () => {
		const plan = planClickBatch([{ x: 10, y: 20 }, { x: 30, y: 40 }, { target: "Send" }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: table({}),
		});
		expect(plan).toMatchObject({ ok: false, failedAt: 2, code: "guardrail_refusal", kind: "permanent" });
		if (plan.ok) return;
		// Two steps validated, but the plan is not "ok", so the executor has
		// nothing to run — plannedBefore is diagnostic, never a licence.
		expect(plan.plannedBefore).toBe(2);
		expect(plan.error).toContain("Send");
	});

	test("a final-action word is refused even when its coordinates are also out of frame", () => {
		// Guardrail order must match validateInjection: refusal beats bounds.
		const plan = planClickBatch([{ target: "Delete", x: 99999, y: 99999 }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: table({ Delete: { x: 99999, y: 99999 } }),
		});
		expect(plan).toMatchObject({ ok: false, code: "guardrail_refusal" });
	});

	test("a word that is not on screen fails permanently at its own index", () => {
		const plan = planClickBatch([{ x: 10, y: 20 }, { target: "Nowhere" }, { x: 30, y: 40 }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: table({}),
		});
		expect(plan).toMatchObject({ ok: false, failedAt: 1, code: "target_not_found", kind: "permanent" });
		if (!plan.ok) expect(plan.error).toContain("Nothing was clicked");
	});

	test("out-of-bounds is caught per step, not just the first", () => {
		const plan = planClickBatch(
			[
				{ x: 10, y: 20 },
				{ x: 5000, y: 20 },
			],
			{
				frame: FRAME,
				focusedAddress: "win1",
				resolve: table({}),
			},
		);
		expect(plan).toMatchObject({ ok: false, failedAt: 1, code: "out_of_bounds" });
	});
	test("negative coordinates are refused too", () => {
		const plan = planClickBatch([{ x: -1, y: 20 }], { frame: FRAME, focusedAddress: "win1", resolve: table({}) });
		expect(plan).toMatchObject({ ok: false, failedAt: 0, code: "out_of_bounds" });
	});

	test("a step with neither target nor x/y is unresolvable", () => {
		const plan = planClickBatch([{ x: 10, y: 20 }, {}], { frame: FRAME, focusedAddress: "win1", resolve: table({}) });
		expect(plan).toMatchObject({ ok: false, failedAt: 1, code: "missing_xy" });
	});

	test("a step naming both a target and x/y is refused, not silently precedence-resolved", () => {
		// The single-click path lets target win. Repeating that precedence N
		// times inside a batch would hide a caller mistake N times over.
		const plan = planClickBatch([{ target: "Compose", x: 10, y: 20 }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: table({ Compose: { x: 160, y: 215 } }),
		});
		expect(plan).toMatchObject({ ok: false, failedAt: 0, code: "step_target_xor_xy" });
	});

	test("mixed buttons across steps are allowed", () => {
		const plan = planClickBatch(
			[
				{ x: 10, y: 20, button: "left" },
				{ x: 30, y: 40, button: "middle" },
				{ x: 50, y: 60, button: "right" },
			],
			{ frame: FRAME, focusedAddress: "win1", resolve: table({}) },
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.planned.map(p => p.button)).toEqual(["left", "middle", "right"]);
	});

	test("mixed word and coordinate steps are allowed", () => {
		const plan = planClickBatch([{ target: "Compose" }, { x: 30, y: 40 }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: table({ Compose: { x: 160, y: 215 } }),
		});
		expect(plan.ok).toBe(true);
	});

	test("a stale frame refuses the whole batch as transient", () => {
		const plan = planClickBatch([{ x: 10, y: 20 }], {
			frame: FRAME,
			focusedAddress: "somewhere_else",
			resolve: table({}),
		});
		expect(plan).toMatchObject({ ok: false, failedAt: -1, code: "frame_stale", kind: "transient" });
	});

	test("no frame refuses the whole batch", () => {
		const plan = planClickBatch([{ x: 10, y: 20 }], { frame: null, focusedAddress: "win1", resolve: table({}) });
		expect(plan).toMatchObject({ ok: false, failedAt: -1, code: "no_frame", kind: "permanent" });
	});

	test("an empty batch is refused", () => {
		const plan = planClickBatch([], { frame: FRAME, focusedAddress: "win1", resolve: table({}) });
		expect(plan).toMatchObject({ ok: false, code: "empty_batch" });
	});

	test("a batch over the cap is refused whole, with the cap named", () => {
		const many = Array.from({ length: BATCH_MAX_STEPS + 1 }, () => ({ x: 10, y: 20 }));
		const plan = planClickBatch(many, { frame: FRAME, focusedAddress: "win1", resolve: table({}) });
		expect(plan).toMatchObject({ ok: false, code: "batch_too_long" });
		if (!plan.ok) expect(plan.error).toContain(String(BATCH_MAX_STEPS));
	});

	test("a batch exactly at the cap is allowed", () => {
		const atCap = Array.from({ length: BATCH_MAX_STEPS }, () => ({ x: 10, y: 20 }));
		const plan = planClickBatch(atCap, { frame: FRAME, focusedAddress: "win1", resolve: table({}) });
		expect(plan.ok).toBe(true);
		if (plan.ok) expect(plan.planned).toHaveLength(BATCH_MAX_STEPS);
	});

	test("plans against the real remembered-target resolver, not a stub", () => {
		// Proves the planner composes with the production matcher: the same
		// word→centre path a single click uses.
		rememberClickTargets([{ text: "Compose", x: 100, y: 200, w: 120, h: 30, confidence: 0.9 }]);
		const plan = planClickBatch([{ target: "compose" }], {
			frame: FRAME,
			focusedAddress: "win1",
			resolve: w => {
				const hit = resolveClickTarget(w);
				return hit ? { x: hit.x, y: hit.y } : null;
			},
		});
		expect(plan.ok).toBe(true);
		if (plan.ok) expect(plan.planned[0]).toMatchObject({ tx: 160, ty: 215 });
	});
});

describe("runClickBatch (guarded execution: re-validate each step, halt on first failure)", () => {
	const step = (over: Partial<PlannedClickStep> = {}): PlannedClickStep => ({
		index: 0,
		tx: 10,
		ty: 20,
		button: "left",
		count: 1,
		settleMs: 0,
		...over,
	});
	const noSleep = async () => {};
	const focused = async () => null;

	test("every step fires once, in order", async () => {
		const clicked: Array<[number, number]> = [];
		const run = await runClickBatch(
			[step({ index: 0, tx: 1, ty: 2 }), step({ index: 1, tx: 3, ty: 4 }), step({ index: 2, tx: 5, ty: 6 })],
			{
				expectedWindowAddress: "win1",
				click: async s => {
					clicked.push([s.tx, s.ty]);
					return null;
				},
				assertFocus: focused,
				sleep: noSleep,
			},
		);
		expect(run.failure).toBeNull();
		expect(run.completedSteps).toBe(3);
		expect(clicked).toEqual([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
	});

	test("focus is re-asserted before EVERY step, not once for the batch", async () => {
		let checks = 0;
		await runClickBatch([step({ index: 0 }), step({ index: 1 }), step({ index: 2 })], {
			expectedWindowAddress: "win1",
			click: async () => null,
			assertFocus: async () => {
				checks++;
				return null;
			},
			sleep: noSleep,
		});
		expect(checks).toBe(3);
	});

	test("a mid-batch input failure halts at exactly that step", async () => {
		const clicked: number[] = [];
		const run = await runClickBatch([step({ index: 0 }), step({ index: 1 }), step({ index: 2 })], {
			expectedWindowAddress: "win1",
			click: async s => {
				clicked.push(s.index);
				return s.index === 1 ? "ydotool exited 1" : null;
			},
			assertFocus: focused,
			sleep: noSleep,
		});
		// Step 2 failed, so step 3 must NOT have been pressed.
		expect(clicked).toEqual([0, 1]);
		expect(run.completedSteps).toBe(1);
		expect(run.failure).toMatchObject({ code: "input_failed", at: 1 });
		expect(run.applied).toHaveLength(1);
	});

	test("focus loss halts the batch and is classified transient", async () => {
		let calls = 0;
		const run = await runClickBatch([step({ index: 0 }), step({ index: 1 })], {
			expectedWindowAddress: "win1",
			click: async () => {
				calls++;
				return null;
			},
			assertFocus: async () => (calls === 1 ? "focus moved to another window" : null),
			sleep: noSleep,
		});
		expect(calls).toBe(1);
		expect(run.failure).toMatchObject({ code: "focus_lost", at: 1 });
		expect(run.completedSteps).toBe(1);
		expect(batchFailureKind(run.failure?.code)).toBe("transient");
	});

	// The reason per-step re-resolution exists: step 1's click changed the
	// screen, so step 2's word may no longer be where the plan recorded it.
	test("a word target that vanished after an earlier step halts before the press", async () => {
		const clicked: string[] = [];
		const run = await runClickBatch([step({ index: 0 }), step({ index: 1, target: "Save" })], {
			expectedWindowAddress: "win1",
			click: async s => {
				clicked.push(s.target ?? "coord");
				return null;
			},
			resolve: () => null,
			assertFocus: focused,
			sleep: noSleep,
		});
		expect(clicked).toEqual(["coord"]);
		expect(run.failure).toMatchObject({ code: "target_not_found", at: 1 });
		expect(run.failure?.error).toContain("Save");
		expect(run.completedSteps).toBe(1);
	});

	test("a moved word target is re-resolved to its NEW position, not the plan's", async () => {
		const clicked: Array<[number, number]> = [];
		const run = await runClickBatch([step({ index: 0, target: "Save", tx: 999, ty: 999 })], {
			expectedWindowAddress: "win1",
			click: async s => {
				clicked.push([s.tx, s.ty]);
				return null;
			},
			// The word is now somewhere else entirely.
			resolve: () => ({ x: 42, y: 43 }),
			assertFocus: focused,
			sleep: noSleep,
		});
		expect(run.failure).toBeNull();
		expect(clicked).toEqual([[42, 43]]);
		expect(run.applied[0]!.frame).toEqual([42, 43]);
	});

	test("no settle after the last step, and none on the way to a failure", async () => {
		const slept: number[] = [];
		await runClickBatch([step({ index: 0, settleMs: 50 }), step({ index: 1, settleMs: 50 })], {
			expectedWindowAddress: "win1",
			click: async () => null,
			assertFocus: focused,
			sleep: async ms => {
				slept.push(ms);
			},
		});
		// One gap for two steps — the trailing one would be dead time.
		expect(slept).toEqual([50]);

		const slept2: number[] = [];
		await runClickBatch([step({ index: 0, settleMs: 50 }), step({ index: 1, settleMs: 50 })], {
			expectedWindowAddress: "win1",
			click: async s => (s.index === 1 ? "boom" : null),
			assertFocus: focused,
			sleep: async ms => {
				slept2.push(ms);
			},
		});
		expect(slept2).toEqual([50]);
	});

	test("a zero settleMs means no wait between steps", async () => {
		const slept: number[] = [];
		await runClickBatch([step({ index: 0, settleMs: 0 }), step({ index: 1, settleMs: 0 })], {
			expectedWindowAddress: "win1",
			click: async () => null,
			assertFocus: focused,
			sleep: async ms => {
				slept.push(ms);
			},
		});
		expect(slept).toEqual([]);
	});

	test("cancellation stops the batch before the next press", async () => {
		const ac = new AbortController();
		const clicked: number[] = [];
		const run = await runClickBatch([step({ index: 0 }), step({ index: 1 }), step({ index: 2 })], {
			expectedWindowAddress: "win1",
			click: async s => {
				clicked.push(s.index);
				ac.abort();
				return null;
			},
			signal: ac.signal,
			assertFocus: focused,
			sleep: noSleep,
		});
		expect(clicked).toEqual([0]);
		expect(run.failure).toMatchObject({ code: "aborted", at: 1 });
		expect(run.completedSteps).toBe(1);
	});

	test("an empty plan succeeds trivially without clicking", async () => {
		let calls = 0;
		const run = await runClickBatch([], {
			expectedWindowAddress: "win1",
			click: async () => {
				calls++;
				return null;
			},
			assertFocus: focused,
		});
		expect(run.failure).toBeNull();
		expect(calls).toBe(0);
	});

	test("a single-step batch behaves like one click", async () => {
		const run = await runClickBatch([step({ index: 0, tx: 7, ty: 8, button: "right", count: 2 })], {
			expectedWindowAddress: "win1",
			click: async s => {
				expect([s.tx, s.ty, s.button, s.count]).toEqual([7, 8, "right", 2]);
				return null;
			},
			assertFocus: focused,
		});
		expect(run.failure).toBeNull();
		expect(run.completedSteps).toBe(1);
	});
});

describe("batch schema validation (fails before any planner runs)", () => {
	const parse = (obj: unknown) => schema.safeParse(obj);
	const base = { action: "live_click" as const };

	test("a well-formed batch parses", () => {
		const r = parse({ ...base, steps: [{ target: "Compose" }, { x: 10, y: 20, button: "right", count: 2 }] });
		expect(r.success).toBe(true);
	});
	test("steps plus a scalar target is refused", () => {
		const r = parse({ ...base, target: "Compose", steps: [{ x: 10, y: 20 }] });
		expect(r.success).toBe(false);
	});
	test("steps plus scalar x/y is refused", () => {
		const r = parse({ ...base, x: 10, y: 20, steps: [{ x: 30, y: 40 }] });
		expect(r.success).toBe(false);
	});
	test("steps on a non-click action is refused", () => {
		for (const action of ["live_move", "live_drag", "live_type", "live_key", "live_scroll"]) {
			const r = parse({ action, steps: [{ x: 10, y: 20 }] });
			expect(r.success).toBe(false);
		}
	});
	test("a step with neither target nor x/y is refused, naming the step", () => {
		const r = parse({ ...base, steps: [{ x: 10, y: 20 }, {}] });
		expect(r.success).toBe(false);
		if (!r.success) {
			const msg = r.error.issues.map(i => i.message).join(" ");
			expect(msg).toContain("step 2");
		}
	});
	test("a step with both target and x/y is refused", () => {
		const r = parse({ ...base, steps: [{ target: "Compose", x: 10, y: 20 }] });
		expect(r.success).toBe(false);
	});
	test("a step with only x, or only y, is refused", () => {
		expect(parse({ ...base, steps: [{ x: 10 }] }).success).toBe(false);
		expect(parse({ ...base, steps: [{ y: 20 }] }).success).toBe(false);
	});
	test("an empty steps array is refused by the schema's min(1)", () => {
		expect(parse({ ...base, steps: [] }).success).toBe(false);
	});
	test("an over-cap steps array is refused by the schema's max(12)", () => {
		const many = Array.from({ length: 13 }, () => ({ x: 10, y: 20 }));
		expect(parse({ ...base, steps: many }).success).toBe(false);
	});
	test("out-of-range count and settleMs are refused per step", () => {
		expect(parse({ ...base, steps: [{ x: 1, y: 1, count: 0 }] }).success).toBe(false);
		expect(parse({ ...base, steps: [{ x: 1, y: 1, count: 21 }] }).success).toBe(false);
		expect(parse({ ...base, steps: [{ x: 1, y: 1, settleMs: -1 }] }).success).toBe(false);
		expect(parse({ ...base, steps: [{ x: 1, y: 1, settleMs: 5001 }] }).success).toBe(false);
	});
	// The scalar single-click shape must survive untouched.
	test("the plain single-click call still parses", () => {
		expect(parse({ ...base, target: "Compose" }).success).toBe(true);
		expect(parse({ ...base, x: 10, y: 20 }).success).toBe(true);
		expect(parse({ ...base, x: 10, y: 20, button: "middle", count: 2 }).success).toBe(true);
	});
});
