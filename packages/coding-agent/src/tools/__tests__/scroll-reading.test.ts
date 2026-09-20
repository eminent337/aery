/**
 * Pinning tests for read-while-scrolling (phase 1: must FAIL for the right
 * reason — the scroll-reading stubs throw — except the settled-gate pin
 * which passes and guards the change-based contract under scroll).
 */
import { describe, expect, test } from "bun:test";
import {
	mergeScrollTargets,
	resolveScrollTarget,
	scrollSettled,
	scrollWordToDocument,
	SCROLL_MERGE_TOLERANCE_PX,
} from "../scroll-reading";
import { observationInputStatus } from "../desktop-control";

const WORD = { text: "Save", x: 100, y: 200, w: 60, h: 20, confidence: 0.9 };
const TAGGED = (over: Record<string, unknown> = {}) => ({
	text: "Save", x: 100, y: 200, w: 60, h: 20, confidence: 0.9, scrollY: 0, docY: 200, ...over,
});

describe("scroll-reading pinning (phase 1: fail for the right reason)", () => {
	test("viewport word + scroll offset maps to stable document space", () => {
		// Word at viewport y=200 read at scroll offset 880 → doc y 1080.
		const doc = scrollWordToDocument(WORD, 880);
		expect(doc.y).toBe(1080);
		expect(doc.x).toBe(WORD.x);
		expect(doc.text).toBe("Save");
	});

	test("same word across frames merges to one target at the new viewport box", () => {
		// "Save" read at scroll 0 (viewport y 200), then at scroll 300 the
		// same document row sits at viewport y≈-100: one target, moved box.
		const prev = [TAGGED()];
		const moved = [{ ...WORD, y: -100, confidence: 0.45 }]; // blurred mid-motion reread
		const merged = mergeScrollTargets(prev, moved, 300, 880);
		expect(merged).toHaveLength(1);
		expect(merged[0].docY).toBe(200);
		expect(merged[0].y).toBe(-100);
		expect(merged[0].scrollY).toBe(300);
	});

	test("genuinely new text is added, scrolled-out targets dropped", () => {
		const prev = [TAGGED()];
		const words = [{ ...WORD, text: "Cancel", y: 400, confidence: 0.9 }];
		const merged = mergeScrollTargets(prev, words, 300, 880);
		expect(merged.map(t => t.text).sort()).toEqual(["Cancel"]);
	});

	test("settle detection: equal trailing offsets settle, drift never does", () => {
		expect(scrollSettled([880, 880, 880])).toBe(true);
		expect(scrollSettled([776, 880, 880])).toBe(false);
		expect(scrollSettled([NaN, NaN, NaN])).toBe(false);
	});

	test("stale-offset targets never resolve blindly (fail-closed)", () => {
		const stale = [TAGGED({ scrollY: 0, y: 200, docY: 200 })];
		expect(resolveScrollTarget(stale, "Save", 880)).toBeNull();
		const fresh = [TAGGED({ scrollY: 880, y: 100, docY: 200 })];
		expect(resolveScrollTarget(fresh, "Save", 880)?.box.docY).toBe(200);
	});

	test("merge tolerance is a small jitter budget, not a row height", () => {
		expect(SCROLL_MERGE_TOLERANCE_PX).toBeLessThanOrEqual(12);
	});
});

describe("settled-gate pin (passes: scroll never invalidates identity)", () => {
	// Pinned human-eye contract: scroll moves CONTENT, not the window — same
	// address + same rect stays fresh at ANY age, so a post-scroll click on a
	// settled frame is allowed without a re-glance.
	const FRAME = { kind: "window", atX: 646, atY: 178, physW: 1252, physH: 880, scaledW: 1252, scaledH: 880, address: "0xB" } as const;
	test("same address+rect is fresh after a scroll no matter the age", () => {
		const snap: any = { generation: 1, address: "0xB", frame: { ...FRAME }, capturedAt: 1_000, windowRect: { at: [646, 90], size: [1252, 968] } };
		const st = observationInputStatus({
			snapshot: snap, activeAddress: "0xB", freshFrame: null,
			activeGeometry: { at: [646, 90], size: [1252, 968] }, now: 60_000, maxAgeMs: 1500,
		});
		expect(st.state).toBe("fresh");
		expect(st.ageMs).toBe(59_000);
	});
	test("a moved/resized window still refuses after scroll", () => {
		const snap: any = { generation: 1, address: "0xB", frame: { ...FRAME }, capturedAt: 1_000, windowRect: { at: [646, 90], size: [1252, 968] } };
		const st = observationInputStatus({
			snapshot: snap, activeAddress: "0xB", freshFrame: null,
			activeGeometry: { at: [700, 90], size: [1252, 968] }, now: 60_000, maxAgeMs: 1500,
		});
		expect(st.state).toBe("geometry_mismatch");
	});
});

describe("scrollReadTick — reading feed policy for moving-but-same-document scenes", () => {
	const R0 = { at: [646, 90] as [number, number], size: [1252, 968] as [number, number] };
	function controllerWith(gen = 1): any {
		const { ObservationController } = require("../live-observe");
		const c = new ObservationController();
		c.start("0xB", { kind: "window", atX: 646, atY: 178, physW: 1252, physH: 880, scaledW: 1252, scaledH: 880, address: "0xB" }, 1000, R0);
		return c;
	}
	test("same address mid-scroll → notes scrollY + OCR and re-asserts freshness", () => {
		const { scrollReadTick } = require("../scroll-reading");
		const c = controllerWith();
		const d = scrollReadTick(1, { address: "0xB", scrollY: 430, ocrText: "Save Cancel" }, c, 1500);
		expect(d.action).toBe("note");
		expect(c.get()?.scrollY).toBe(430);
		expect(c.get()?.ocrText).toBe("Save Cancel");
		expect(c.get()?.capturedAt).toBe(1500);
	});

	test("address mismatch → never notes (a mis-aimed read cannot ride another window)", () => {
		const { scrollReadTick } = require("../scroll-reading");
		const c = controllerWith();
		const d = scrollReadTick(1, { address: "0xDEAD", scrollY: 430 }, c, 1500);
		expect(d.action).toBe("noop");
		expect(c.get()?.scrollY).toBeUndefined();
	});

	test("generation mismatch → noop; missing/superseded → stop", () => {
		const { scrollReadTick } = require("../scroll-reading");
		const c = controllerWith();
		expect(scrollReadTick(9, { address: "0xB", scrollY: 10 }, c, 1500).action).toBe("noop");
		c.cancel();
		expect(scrollReadTick(1, { address: "0xB", scrollY: 10 }, c, 1500).action).toBe("stop");
	});

	test("non-finite scroll offset never notes (fail-closed on unusable data)", () => {
		const { scrollReadTick } = require("../scroll-reading");
		const c = controllerWith();
		const d = scrollReadTick(1, { address: "0xB", scrollY: Number.NaN }, c, 1500);
		expect(d.action).toBe("noop");
		expect(c.get()?.scrollY).toBeUndefined();
	});
});

describe("scroll frame quality + burst reader (phase 3)", () => {
	const GOOD = [
		{ text: "Save", x: 100, y: 200, w: 60, h: 20, confidence: 0.9 },
		{ text: "Cancel", x: 100, y: 260, w: 70, h: 20, confidence: 0.85 },
		{ text: "Refresh", x: 100, y: 320, w: 80, h: 20, confidence: 0.88 },
	];
	test("planScrollReadBurst clamps steps and keeps a fast capture cadence", () => {
		const { planScrollReadBurst } = require("../scroll-reading");
		const p = planScrollReadBurst({ count: 99, scrollSpeed: "fast" });
		expect(p.steps).toBe(20);
		expect(p.speed).toBe("fast");
		expect(p.intervalMs).toBe(80);
		expect(p.sample).toBe(true);
		expect(planScrollReadBurst({ count: 0 }).steps).toBe(1);
	});

	test("scrollFrameQuality: crisp frame trusted, garbled/sparse frame not", () => {
		const { scrollFrameQuality } = require("../scroll-reading");
		const good = scrollFrameQuality(GOOD);
		expect(good.wordCount).toBe(3);
		expect(good.trustworthy).toBe(true);
		const garbled = scrollFrameQuality([
			{ text: "c «phimestistiber", x: 10, y: 10, w: 200, h: 30, confidence: 0.4 },
			{ text: "=", x: 10, y: 50, w: 8, h: 20, confidence: 0.3 },
			{ text: "VALULS", x: 10, y: 90, w: 100, h: 24, confidence: 0.35 },
		]);
		expect(garbled.trustworthy).toBe(false);
		const sparse = scrollFrameQuality([]);
		expect(sparse.trustworthy).toBe(false);
	});

	test("scrollFrameQuality rewards overlap with the baseline reading", () => {
		const { scrollFrameQuality } = require("../scroll-reading");
		const base = new Set(["save", "cancel", "refresh"]);
		const withOverlap = scrollFrameQuality(GOOD, base);
		const without = scrollFrameQuality([{ text: "xyzzy", x: 0, y: 0, w: 20, h: 10, confidence: 0.5 }], base);
		expect(withOverlap.overlap).toBeGreaterThan(without.overlap);
	});

	test("runScrollReadBurst: capture-while-moving, feeds ticks, aborts on focus loss", async () => {
		const { runScrollReadBurst } = require("../scroll-reading");
		const { ObservationController } = require("../live-observe");
		const R0 = { at: [646, 90], size: [1252, 968] };
		const c = new ObservationController();
		c.start("0xB", { kind: "window", atX: 646, atY: 178, physW: 1252, physH: 880, scaledW: 1252, scaledH: 880, address: "0xB" }, 1000, R0);
		let step = 0;
		const scrolls = [0, 300, 600];
		const frames = [
			{ words: GOOD, quality: { wordCount: 3, overlap: 1, trustworthy: true } },
			{ words: [{ ...GOOD[0], y: -40 }], quality: { wordCount: 1, overlap: 0.33, trustworthy: true } },
			{ words: GOOD.map(w => ({ ...w, y: w.y - 400 })), quality: { wordCount: 3, overlap: 1, trustworthy: true } },
		];
		const res = await runScrollReadBurst(
			[["ydotool"], ["ydotool"], ["ydotool"]],
			{
				intervalMs: 10, sample: true, expectedWindowAddress: "0xB",
				assertFocus: async () => null,
				run: async () => null,
				captureFrame: async () => ({ scrollY: scrolls[Math.min(step, 2)], at: 1000 + step * 100, path: `/tmp/srb-${step}.png` }),
				ocrFrame: async () => frames[Math.min(step++, 2)],
				control: c,
			},
		);
		expect(res.failure).toBeNull();
		expect(res.completedSteps).toBe(3);
		expect(res.readings).toHaveLength(3);
		expect(res.readings[2].scrollY).toBe(600);
		// every reading was fed: snapshot carries the LAST scroll offset
		expect(c.get()?.scrollY).toBe(600);
		// targets accumulated across frames via mergeScrollTargets
		expect(res.targets.some((t: { text: string }) => t.text === "Refresh")).toBe(true);
		// focus loss aborts before the next injection
		const c2 = new ObservationController();
		c2.start("0xB", null, 1000, R0);
		let ran = 0;
		const res2 = await runScrollReadBurst(
			[["a"], ["b"], ["c"]],
			{
				intervalMs: 0, sample: false, expectedWindowAddress: "0xB",
				assertFocus: async () => (ran++ === 1 ? "focus lost" : null),
				run: async () => null,
				captureFrame: async () => ({ scrollY: 0, at: 0, path: "" }),
				ocrFrame: async () => ({ words: [], quality: { wordCount: 0, overlap: 0, trustworthy: false } }),
				control: c2,
			},
		);
		expect(res2.failure).toBe("focus lost");
		expect(res2.completedSteps).toBe(1);
	});
});

describe("targets stay usable during AND after scroll (regression)", () => {
	const W = (text: string, y: number, conf = 0.9) => ({ text, x: 100, y, w: 60, h: 20, confidence: conf });
	test("mid-scroll frame keeps a target clickable at its CURRENT viewport box", () => {
		// "Save" settled at doc y=200; mid-scroll (offset 150) it sits at viewport y=50.
		let t = mergeScrollTargets([], [W("Save", 200)], 0, 880);
		t = mergeScrollTargets(t, [W("Save", 50)], 150, 880);
		const hit = resolveScrollTarget(t, "Save", 150);
		expect(hit).not.toBeNull();
		expect(hit?.y).toBe(60); // 50 + 20/2
		// still addressable after the scroll continues past it? NO — fail-closed:
		expect(resolveScrollTarget(t, "Save", 880)).toBeNull();
	});

	test("settled reread upgrades a blurred mid-motion read (confidence keeps best)", () => {
		let t = mergeScrollTargets([], [W("Save", 200, 0.4)], 0, 880);
		t = mergeScrollTargets(t, [W("Save", 200, 0.95)], 0, 880);
		expect(t[0].confidence).toBe(0.95);
		// and a crisp read never downgrades to a later blur
		t = mergeScrollTargets(t, [W("Save", 200, 0.3)], 0, 880);
		expect(t[0].confidence).toBe(0.95);
	});

	test("targets drop once genuinely scrolled out of view (map never grows unbounded)", () => {
		let t = mergeScrollTargets([], [W("Save", 100), W("Far", 2500)], 0, 880);
		// after scrolling 3000px, "Save" (docY 100) is far above; "Far" (docY 2500) now near view bottom
		t = mergeScrollTargets(t, [W("Far", 200)], 3000, 880);
		expect(t.map(x => x.text)).toEqual(["Far"]);
	});

	test("scrollSettled drives the handoff: mid-motion merges, settled read finalizes", () => {
		const offsets = [0, 300, 600, 880, 880, 880];
		expect(scrollSettled(offsets)).toBe(true);
		let t: any[] = [];
		for (let i = 0; i < offsets.length - 1; i++) t = mergeScrollTargets(t, [W("Save", 880 - offsets[i])], offsets[i], 880);
		const final = mergeScrollTargets(t, [W("Save", 0)], 880, 880); // settled read
		const hit = resolveScrollTarget(final, "Save", 880);
		expect(hit?.y).toBe(10);
		expect(scrollSettled([880, 880, 881])).toBe(false);
	});
});
