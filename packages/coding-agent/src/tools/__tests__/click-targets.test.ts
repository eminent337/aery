import { describe, expect, test } from "bun:test";
import {
	clickTargetsFromOcr,
	cursorVerifyNote,
	formatClickTargets,
	isJunkTargetWord,
	liveAimGlide,
	livePathTrajectory,
	rememberClickTargets,
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
		const hops = livePathTrajectory({ x: 0, y: 0 }, [{ x: 300, y: 300 }, { x: 600, y: 0 }]);
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
		for (let i = 0; i < 64; i++) waypoints.push({ x: (i % 2 ? 1900 : 20), y: 20 + i * 16 });
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
		expect(livePathTrajectory({ x: 5, y: 5 }, [{ x: 5, y: 5 }, { x: 5, y: 5 }])).toEqual([
			{ x: 5, y: 5, gapMs: 16 },
		]);
	});
});