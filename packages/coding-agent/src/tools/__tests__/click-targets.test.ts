import { describe, expect, test } from "bun:test";
import {
	clickTargetsFromOcr,
	cursorVerifyNote,
	formatClickTargets,
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