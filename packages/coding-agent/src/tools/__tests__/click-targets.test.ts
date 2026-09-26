import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clickTargetsFromOcr,
	cursorVerifyNote,
	formatClickTargets,
	framesCoherent,
	isJunkTargetWord,
	liveAimGlide,
	livePathPace,
	livePathTrajectory,
	rememberClickTargets,
	rememberFrame,
	resolveClickTarget,
} from "../desktop-control";

const FRAME_1280 = { kind: "window" as const, atX: 0, atY: 0, physW: 1280, physH: 800, scaledW: 1280, scaledH: 800 };

describe("clickTargetsFromOcr frame mapping (regression: eye frame anchoring)", () => {
	test("no frame yields no targets (never guess a coordinate space)", () => {
		expect(clickTargetsFromOcr([{ text: "OK", x: 10, y: 10, w: 20, h: 10, confidence: 0.9 }], null)).toEqual([]);
	});
	test("words inside the frame pass through unchanged", () => {
		const t = clickTargetsFromOcr([{ text: "Compose", x: 40, y: 50, w: 100, h: 24, confidence: 0.9 }], FRAME_1280);
		expect(t).toEqual([{ text: "Compose", x: 40, y: 50, w: 100, h: 24, confidence: 0.9 }]);
	});
	test("boxes beyond the frame edge are clamped, not dropped", () => {
		const t = clickTargetsFromOcr([{ text: "Edge", x: 1270, y: 795, w: 60, h: 20, confidence: 0.8 }], FRAME_1280);
		expect(t).toHaveLength(1);
		expect(t[0].w).toBe(10); // 1280 - 1270
		expect(t[0].h).toBe(5); // 800 - 795
	});
	test("a smaller frame (different window) drops out-of-range words", () => {
		// The old bug: word boxes from a 1280-wide glance clamped against a
		// 765-wide stale frame → every right-hand word collapsed to the edge.
		const small = { kind: "window" as const, atX: 0, atY: 0, physW: 926, physH: 968, scaledW: 765, scaledH: 800 };
		const t = clickTargetsFromOcr(
			[
				{ text: "Fine", x: 100, y: 100, w: 40, h: 12, confidence: 0.9 },
				{ text: "Offscreen", x: 900, y: 100, w: 40, h: 12, confidence: 0.9 },
			],
			small,
		);
		expect(t.map(x => x.text)).toEqual(["Fine"]);
	});
});

const SAMPLE = [
	{ text: "Compose", x: 100, y: 200, w: 120, h: 30, confidence: 0.93 },
	{ text: "Send", x: 500, y: 300, w: 80, h: 26, confidence: 0.88 },
	{ text: "Subject", x: 200, y: 400, w: 140, h: 24, confidence: 0.75 },
	{ text: "Compose", x: 20, y: 500, w: 100, h: 20, confidence: 0.5 }, // body mention
];

describe("clickable-OCR click targets (D002/D004)", () => {
	test("resolveClickTarget returns the box center for an exact label match", () => {
		rememberClickTargets(SAMPLE);
		const hit = resolveClickTarget("Send");
		expect(hit).not.toBeNull();
		expect(hit?.x).toBe(540); // 500 + 80/2
		expect(hit?.y).toBe(313);
		expect(hit?.box.text).toBe("Send");
	});
	test("exact match beats a substring/body mention", () => {
		rememberClickTargets(SAMPLE);
		// "Compose" has an exact UI label AND a body mention; exact (shorter or
		// earlier) wins — the topmost exact box, not the later body word.
		const hit = resolveClickTarget("compose");
		expect(hit?.box.y).toBe(200);
	});
	test("substring match finds partial labels case-insensitively", () => {
		rememberClickTargets(SAMPLE);
		const hit = resolveClickTarget("subj");
		expect(hit?.box.text).toBe("Subject");
	});
	test("unknown target returns null", () => {
		rememberClickTargets(SAMPLE);
		expect(resolveClickTarget("DefinitelyNotThere")).toBeNull();
	});
	test("formatClickTargets renders compact frame-px lines", () => {
		const out = formatClickTargets(SAMPLE, 2);
		expect(out).toContain("Clickable words");
		expect(out).toContain('(100,200) 120x30 "Compose"');
		expect(out.split("\n").length).toBe(1 + 2);
	});
});

describe("cursorVerifyNote (≤2px, same-space)", () => {
	test("exact match passes", () => {
		expect(cursorVerifyNote({ x: 512, y: 288 }, { x: 512, y: 288 })).toContain("OK");
	});
	test("within tolerance passes", () => {
		expect(cursorVerifyNote({ x: 512, y: 288 }, { x: 514, y: 286 })).toContain("OK");
	});
	test("beyond tolerance flags a mismatch with retry advice", () => {
		const note = cursorVerifyNote({ x: 512, y: 288 }, { x: 600, y: 400 });
		expect(note).toContain("MISMATCH");
		expect(note).toContain("re-eye");
	});
	test("null read (unsupported backend) yields no note", () => {
		expect(cursorVerifyNote({ x: 512, y: 288 }, null)).toBe("");
	});
});

describe("cursor fix: word-boundary tier matching", () => {
	test("phrase match beats substring ('Send' hits 'Send message', not 'Resend')", () => {
		rememberClickTargets([
			{ text: "Resend", x: 10, y: 10, w: 60, h: 20, confidence: 0.9 },
			{ text: "Send message", x: 10, y: 100, w: 120, h: 20, confidence: 0.9 },
		]);
		expect(resolveClickTarget("Send")?.box.text).toBe("Send message");
	});
	test("exact match still wins over phrase", () => {
		rememberClickTargets([
			{ text: "Send message", x: 10, y: 10, w: 120, h: 20, confidence: 0.9 },
			{ text: "Send", x: 10, y: 100, w: 50, h: 20, confidence: 0.9 },
		]);
		expect(resolveClickTarget("Send")?.box.text).toBe("Send");
	});
	test("pure substring is the last resort, not a miss", () => {
		rememberClickTargets([{ text: "Resend", x: 10, y: 10, w: 60, h: 20, confidence: 0.9 }]);
		expect(resolveClickTarget("Send")?.box.text).toBe("Resend");
	});
	test("stale generations stop resolving (frame-bound contract)", () => {
		rememberClickTargets([{ text: "Old", x: 10, y: 10, w: 40, h: 20, confidence: 0.9 }]);
		expect(resolveClickTarget("Old")).not.toBeNull();
		rememberClickTargets([{ text: "New", x: 20, y: 20, w: 40, h: 20, confidence: 0.9 }]);
		expect(resolveClickTarget("Old")).toBeNull();
		expect(resolveClickTarget("New")).not.toBeNull();
	});
});

describe("cursor fix: junk-word filter", () => {
	test("words with letters/digits are never junk (even mangled titles)", () => {
		expect(isJunkTargetWord("G&=", 0)).toBe(false);
		expect(isJunkTargetWord("0%", 0.55)).toBe(false);
	});
	test("symbol-only low-confidence words are junk", () => {
		expect(isJunkTargetWord("&=", 0)).toBe(true);
		expect(isJunkTargetWord("(=", 0.3)).toBe(true);
	});
	test("symbol-only high-confidence words survive (real icon labels)", () => {
		expect(isJunkTargetWord("+", 0.95)).toBe(false);
		expect(isJunkTargetWord("=", 0.8)).toBe(false);
	});
	test("junk words never become targets", () => {
		const t = clickTargetsFromOcr(
			[
				{ text: "&=", x: 10, y: 10, w: 60, h: 14, confidence: 0 },
				{ text: "Save", x: 100, y: 100, w: 50, h: 20, confidence: 0.9 },
			],
			FRAME_1280,
		);
		expect(t.map(x => x.text)).toEqual(["Save"]);
	});
});

describe("cursor fix: liveAimGlide eased waypoints", () => {
	test("short hops land in one step", () => {
		expect(liveAimGlide({ x: 100, y: 100 }, { x: 110, y: 108 })).toEqual([{ x: 110, y: 108 }]);
	});
	test("long glides ease out and land exactly on target", () => {
		const pts = liveAimGlide({ x: 0, y: 0 }, { x: 600, y: 0 });
		expect(pts.length).toBeGreaterThan(1);
		expect(pts.length).toBeLessThanOrEqual(6);
		const last = pts[pts.length - 1];
		expect(last).toEqual({ x: 600, y: 0 });
		// easeOut: first step covers more ground than the last
		const firstHop = Math.hypot(pts[0].x, pts[0].y);
		const prev = pts[pts.length - 2];
		const lastHop = Math.hypot(last.x - prev.x, last.y - prev.y);
		expect(firstHop).toBeGreaterThan(lastHop);
	});
	test("waypoints stay on the segment (no overshoot)", () => {
		const pts = liveAimGlide({ x: 100, y: 200 }, { x: 500, y: 800 });
		for (const p of pts) {
			expect(p.x).toBeGreaterThanOrEqual(100);
			expect(p.x).toBeLessThanOrEqual(500);
			expect(p.y).toBeGreaterThanOrEqual(200);
			expect(p.y).toBeLessThanOrEqual(800);
		}
	});
});

describe("continuous path: livePathTrajectory", () => {
	test("final hop is exactly the final waypoint (rounded)", () => {
		const hops = livePathTrajectory({ x: 0, y: 0 }, [
			{ x: 100, y: 50 },
			{ x: 233.6, y: 177.4 },
		]);
		const last = hops[hops.length - 1];
		expect(last.x).toBe(234);
		expect(last.y).toBe(177);
	});

	test("every hop is integer px and hops never teleport (≤ budgeted peak)", () => {
		const hops = livePathTrajectory({ x: 10, y: 10 }, [
			{ x: 600, y: 40 },
			{ x: 620, y: 500 },
			{ x: 60, y: 520 },
		]);
		for (const h of hops) {
			expect(Number.isInteger(h.x)).toBe(true);
			expect(Number.isInteger(h.y)).toBe(true);
		}
		// Consecutive hops stay under hopPx+1 (smoothstep peak budgeted in) —
		// a corner sweep must not turn into a jump.
		let maxHop = 0;
		let prev = { x: 10, y: 10 };
		for (const h of hops) {
			maxHop = Math.max(maxHop, Math.hypot(h.x - prev.x, h.y - prev.y));
			prev = h;
		}
		expect(maxHop).toBeLessThanOrEqual(25);
	});

	test("sweeps THROUGH intermediate waypoints (no stop-and-start seams)", () => {
		// Journey passes exactly through the corner (300,300): some hop must
		// land within a hop of it, and hops on either side of it are normal-
		// sized — i.e. the corner is traversed, not teleported across.
		const hops = livePathTrajectory({ x: 0, y: 0 }, [
			{ x: 300, y: 300 },
			{ x: 600, y: 0 },
		]);
		let prev = { x: 0, y: 0 };
		for (const h of hops) {
			expect(Math.hypot(h.x - prev.x, h.y - prev.y)).toBeLessThanOrEqual(25);
			prev = h;
		}
		const nearCorner = hops.some(h => Math.hypot(h.x - 300, h.y - 300) <= 25);
		expect(nearCorner).toBe(true);
	});

	test("total dwell honors the wall-clock cap on a very long path", () => {
		const waypoints: Array<{ x: number; y: number }> = [];
		// ~20k px of travel across 64 waypoints.
		for (let i = 0; i < 64; i++) waypoints.push({ x: i % 2 ? 1900 : 20, y: 20 + i * 16 });
		const hops = livePathTrajectory({ x: 20, y: 20 }, waypoints, { maxTotalMs: 4000 });
		const dwell = hops.reduce((s, h) => s + h.gapMs, 0);
		// N×(gap+spawn) was budgeted ≤4000; summed gaps alone are ≤ that.
		expect(dwell).toBeLessThanOrEqual(4000);
		expect(hops.length).toBeGreaterThan(2);
		const last = hops[hops.length - 1];
		const wLast = waypoints[waypoints.length - 1];
		expect(last.x).toBe(wLast.x);
		expect(last.y).toBe(wLast.y);
	});

	test("degenerate: a no-travel request yields one hop on the spot", () => {
		expect(
			livePathTrajectory({ x: 5, y: 5 }, [
				{ x: 5, y: 5 },
				{ x: 5, y: 5 },
			]),
		).toEqual([{ x: 5, y: 5, gapMs: 16 }]);
	});
});

describe("continuous path: pace profiles and corner easing", () => {
	const L = (x: number, y: number) => ({ x, y });
	const dwellOf = (hops: Array<{ gapMs: number }>) => hops.reduce((s, h) => s + h.gapMs, 0);
	const L_SHAPE = [L(200, 100), L(700, 100), L(700, 600), L(200, 600)];

	test("natural is the default and carries the shipped constants exactly", () => {
		expect(livePathPace(undefined)).toEqual({ hopPx: 24, gapMs: 16, maxTotalMs: 4000, cornerPx: 24 });
		expect(livePathPace("natural")).toEqual({ hopPx: 24, gapMs: 16, maxTotalMs: 4000, cornerPx: 24 });
	});

	test("an omitted pace emits exactly what the pre-pace default emitted", () => {
		// No pace AND pace:"natural" must agree hop for hop — that is the
		// backward-compatibility guarantee for already-shipped callers.
		const a = livePathTrajectory(L(0, 0), L_SHAPE);
		const b = livePathTrajectory(L(0, 0), L_SHAPE, { pace: "natural" });
		expect(b).toEqual(a);
	});

	test("deliberate is measurably slower than natural but lands exactly", () => {
		const from = L(0, 0);
		const natural = livePathTrajectory(from, L_SHAPE, { pace: "natural" });
		const deliberate = livePathTrajectory(from, L_SHAPE, { pace: "deliberate" });
		expect(dwellOf(deliberate)).toBeGreaterThan(dwellOf(natural) * 1.5);
		const last = deliberate[deliberate.length - 1];
		expect(last.x).toBe(200);
		expect(last.y).toBe(600);
	});

	test("brisk is the quickest of the three", () => {
		const from = L(0, 0);
		const brisk = dwellOf(livePathTrajectory(from, L_SHAPE, { pace: "brisk" }));
		const natural = dwellOf(livePathTrajectory(from, L_SHAPE, { pace: "natural" }));
		const deliberate = dwellOf(livePathTrajectory(from, L_SHAPE, { pace: "deliberate" }));
		expect(brisk).toBeLessThan(natural);
		expect(natural).toBeLessThan(deliberate);
	});

	for (const pace of ["brisk", "natural", "deliberate"] as const) {
		test(`${pace}: every waypoint is an EXACT emitted hop (never cut, never skipped)`, () => {
			const from = L(30, 40);
			const hops = livePathTrajectory(from, L_SHAPE, { pace });
			for (const w of L_SHAPE) {
				expect(hops.some(h => h.x === w.x && h.y === w.y)).toBe(true);
			}
		});

		test(`${pace}: hops are integer px, bounded, and land exactly on the final waypoint`, () => {
			const from = L(30, 40);
			const hops = livePathTrajectory(from, L_SHAPE, { pace });
			const bound = livePathPace(pace).hopPx + 1;
			let prev = from;
			for (const h of hops) {
				expect(Number.isInteger(h.x)).toBe(true);
				expect(Number.isInteger(h.y)).toBe(true);
				expect(Math.hypot(h.x - prev.x, h.y - prev.y)).toBeLessThanOrEqual(bound);
				prev = h;
			}
			const last = hops[hops.length - 1]!;
			expect(last.x).toBe(200);
			expect(last.y).toBe(600);
		});

		test(`${pace}: total dwell stays within the pace's own cap`, () => {
			const waypoints: Array<{ x: number; y: number }> = [];
			for (let i = 0; i < 64; i++) waypoints.push(L(i % 2 ? 1900 : 20, 20 + i * 16));
			const cap = livePathPace(pace).maxTotalMs;
			const hops = livePathTrajectory(L(20, 20), waypoints, { pace });
			expect(dwellOf(hops)).toBeLessThanOrEqual(cap);
			const last = hops[hops.length - 1]!;
			expect(last.x).toBe(waypoints[waypoints.length - 1]!.x);
			expect(last.y).toBe(waypoints[waypoints.length - 1]!.y);
		});
	}

	test("at a pace with budget for easing, the turn slows well below the straights", () => {
		// 'deliberate' (8000ms cap) is the pace that guarantees the corner
		// easing. The signature is a Dwell RAMP into each waypoint: gaps climb
		// from the base toward the waypoint and fall back after it, so the
		// slowest hops in the journey are the turn cores. Compare the slowest
		// hop AT each interior waypoint against the fastest hop on a
		// mid-straight — the entry/exit ramps are part of the design, not
		// "straights".
		const from = L(0, 0);
		const hops = livePathTrajectory(from, L_SHAPE, { pace: "deliberate" });
		const base = livePathPace("deliberate").gapMs;
		// Fastest hop that sits at the base dwell AND is away from every
		// waypoint taper zone — i.e. a genuinely full-speed straight hop.
		let fastestStraight = 0;
		for (let i = 0; i < hops.length; i++) {
			const h = hops[i]!;
			if (h.gapMs > base) continue; // in a taper zone
			const d = Math.hypot(h.x - from.x, h.y - from.y);
			if (L_SHAPE.some(w => Math.hypot(h.x - w.x, h.y - w.y) < livePathPace("deliberate").cornerPx + 20)) continue;
			const a = i === 0 ? from : hops[i - 1]!;
			fastestStraight = Math.max(fastestStraight, Math.hypot(h.x - a.x, h.y - a.y) / (h.gapMs + 18));
		}
		expect(fastestStraight).toBeGreaterThan(0);
		// Slowest hop sitting exactly on an interior waypoint.
		let slowestTurn = Infinity;
		for (const w of L_SHAPE.slice(0, -1)) {
			const on = hops.find(h => h.x === w.x && h.y === w.y);
			expect(on).toBeDefined();
			slowestTurn = Math.min(slowestTurn, on!.gapMs);
		}
		expect(slowestTurn).toBeGreaterThan(base * 2);
		// ... and the turn-core speed is below the fastest straight speed.
		const turnSpeed = livePathPace("deliberate").hopPx / (slowestTurn + 18);
		expect(turnSpeed).toBeLessThan(fastestStraight);
	});

	test("a deliberately tight cap wins over the easing, never the other way round", () => {
		// Documented tradeoff: for a path long enough that easing would blow
		// the wall-clock cap, the cap wins — the glide gets faster and coarser
		// rather than hanging. Asserted so the tradeoff can't drift silently.
		const tight = livePathTrajectory(L(0, 0), L_SHAPE, { pace: "natural", maxTotalMs: 1200 });
		const eased = livePathTrajectory(L(0, 0), L_SHAPE, { pace: "natural", maxTotalMs: 1200, cornerPx: 0 });
		expect(dwellOf(tight)).toBeLessThanOrEqual(1200);
		expect(tight.length).toBeLessThanOrEqual(eased.length + 2);
		const last = tight[tight.length - 1]!;
		expect(last.x).toBe(200);
		expect(last.y).toBe(600);
	});

	test("the corner slowdown is confined to a bounded neighborhood of the waypoint", () => {
		const hops = livePathTrajectory(L(0, 0), L_SHAPE, { pace: "deliberate" });
		const base = livePathPace("deliberate").gapMs;
		const slowed = hops.filter(h => h.gapMs > base + 1);
		expect(slowed.length).toBeGreaterThan(0);
		// Every slowed hop is within one corner radius of a waypoint.
		const radius = livePathPace("natural").cornerPx;
		for (const h of slowed) {
			const near = L_SHAPE.some(w => Math.hypot(h.x - w.x, h.y - w.y) <= radius + livePathPace("natural").hopPx);
			expect(near).toBe(true);
		}
	});

	test("all hops stay inside the frame bounding box (fills never leave the path)", () => {
		const xs = [30, 700, 700, 200];
		const ys = [40, 100, 600, 600];
		for (const pace of ["brisk", "natural", "deliberate"] as const) {
			for (const h of livePathTrajectory(L(30, 40), L_SHAPE, { pace })) {
				expect(h.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1);
				expect(h.x).toBeLessThanOrEqual(Math.max(...xs) + 1);
				expect(h.y).toBeGreaterThanOrEqual(Math.min(...ys) - 1);
				expect(h.y).toBeLessThanOrEqual(Math.max(...ys) + 1);
			}
		}
	});
});

describe("same-turn reading coherence (eye + cursor together)", () => {
	// rememberFrame derives frame dims by running `identify` on real files —
	// the same ImageMagick dependency the xvfb suites already rely on.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
	const png = (name: string, size: string): string => {
		const p = path.join(dir, name);
		execFileSync("convert", ["-size", size, "xc:white", p]);
		return p;
	};
	const A1 = png("a1.png", "8x6");
	const A2 = png("a2.png", "8x6");
	const B = png("b.png", "12x9");
	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const WIN_A = {
		address: "0xA",
		title: "Mail",
		class: "mail-app",
		workspace: 1,
		at: [10, 20] as [number, number],
		size: [8, 6] as [number, number],
		focused: true,
	};
	const WIN_B = {
		address: "0xB",
		title: "Editor",
		class: "editor-app",
		workspace: 2,
		at: [0, 0] as [number, number],
		size: [12, 9] as [number, number],
		focused: true,
	};
	const box = { text: "Send", x: 10, y: 10, w: 40, h: 12, confidence: 0.9 };
	const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

	test("a coherent frame/target pair resolves to the box center", async () => {
		const f = await rememberFrame(WIN_A, "10,20 8x6", A1, A1);
		expect(f).not.toBeNull();
		rememberClickTargets([box], f);
		expect(resolveClickTarget("Send")?.x).toBe(30); // 10 + 40/2
	});

	test("a same-window re-capture keeps the pool alive (value coherence)", async () => {
		const f1 = await rememberFrame(WIN_A, "10,20 8x6", A1, A1);
		rememberClickTargets([box], f1);
		const f2 = await rememberFrame(WIN_A, "10,20 8x6", A2, A2);
		expect(f2).not.toBeNull();
		expect(framesCoherent(f1, f2)).toBe(true);
		// Same surface, identical mapping: the exact box still resolves —
		// ordinary serial flows (click → verify → click) never regress.
		expect(resolveClickTarget("Send")).not.toBeNull();
	});

	test("a window swap fails closed instead of mapping old boxes through new coordinates", async () => {
		const f1 = await rememberFrame(WIN_A, "10,20 8x6", A1, A1);
		rememberClickTargets([box], f1);
		const f2 = await rememberFrame(WIN_B, "0,0 12x9", B, B);
		expect(f2).not.toBeNull();
		expect(framesCoherent(f1, f2)).toBe(false);
		expect(resolveClickTarget("Send")).toBeNull();
	});

	test("concurrent publishers end coherent-or-refused, never corrupted (screenshot during an in-flight glide)", async () => {
		// Publisher 1 = a slow screenshot: captures, "OCRs" (delayed), then
		// publishes its targets against ITS OWN frame. Publisher 2 = the
		// glide's verify capture, publishing a different window's frame
		// while publisher 1 is still mid-"OCR".
		await Promise.all([
			(async () => {
				const f = await rememberFrame(WIN_A, "10,20 8x6", A1, A1);
				await sleep(30); // OCR time
				rememberClickTargets([box], f);
			})(),
			(async () => {
				await sleep(10); // the glide's verify lands mid-"OCR"
				await rememberFrame(WIN_B, "0,0 12x9", B, B);
			})(),
		]);
		// Final frame = B (published last), targets paired with A → refused:
		// the pool is never resolved through foreign coordinates.
		expect(resolveClickTarget("Send")).toBeNull();

		// Same-surface variant: both publishers describe window A, so the
		// interleaving stays coherent and the exact box survives.
		await Promise.all([
			(async () => {
				const f = await rememberFrame(WIN_A, "10,20 8x6", A1, A1);
				await sleep(30);
				rememberClickTargets([box], f);
			})(),
			(async () => {
				await sleep(10);
				await rememberFrame(WIN_A, "10,20 8x6", A2, A2);
			})(),
		]);
		expect(resolveClickTarget("Send")?.y).toBe(16); // 10 + 12/2
	});

	test("framesCoherent requires both readings and full surface equality", () => {
		expect(framesCoherent(null, FRAME_1280)).toBe(false);
		expect(framesCoherent(FRAME_1280, { ...FRAME_1280 })).toBe(true);
		expect(framesCoherent(FRAME_1280, { ...FRAME_1280, address: "other" })).toBe(false);
		expect(framesCoherent(FRAME_1280, { ...FRAME_1280, physW: 1279 })).toBe(false);
		expect(framesCoherent(FRAME_1280, { ...FRAME_1280, atX: 5 })).toBe(false);
	});
});
