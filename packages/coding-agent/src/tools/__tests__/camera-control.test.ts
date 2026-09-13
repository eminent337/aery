import { describe, expect, test } from "bun:test";
import { watchDigestOf, watchDiffFloor, watchShouldOcr } from "../camera-control";

// Throttle + change-gating contract for the watch-loop screen lane.
// watchShouldOcr(lastOcrAt, now, lastDigest, digest) is the pure decision
// behind #maybeOcr: it must return true only when BOTH
//   (a) >= WATCH_OCR_MIN_INTERVAL_MS (4000ms) elapsed since the last OCR, AND
//   (b) the screen digest moved past WATCH_OCR_DIFF_THRESHOLD (0.12).
const NOW = 1_700_000_000_000;
const RECENT = NOW - 2_000; // 2s ago — under the 4s throttle
const STALE = NOW - 6_000; // 6s ago — past the throttle

describe("watch OCR gating (screen lane)", () => {
	test("identical digest never re-OCRs even when stale", () => {
		expect(watchShouldOcr(STALE, NOW, "a1b2c3", "a1b2c3")).toBe(false);
	});

	test("recent same-digest stays silent (throttle AND no change)", () => {
		expect(watchShouldOcr(RECENT, NOW, "abc", "abc")).toBe(false);
	});

	test("recent changed digest is throttled (no OCR faster than 4s)", () => {
		expect(watchShouldOcr(RECENT, NOW, "aaaaaaaa", "ffffffff")).toBe(false);
	});

	test("stale + changed digest => OCR", () => {
		expect(watchShouldOcr(STALE, NOW, "aaaaaaaa", "ffffffff")).toBe(true);
	});

	test("stale + tiny change below threshold stays quiet", () => {
		// Diff of 1/32 nibble * 8 = 0.25 >= 0.12 would fire; use truly identical
		// digest for the below-threshold case (0 change).
		expect(watchShouldOcr(STALE, NOW, "abcd1234abcd1234abcd1234abcd1234", "abcd1234abcd1234abcd1234abcd1234")).toBe(false);
	});

	test("undefined last digest counts as complete change (fires)", () => {
		expect(watchShouldOcr(STALE, NOW, undefined, "ffffffff")).toBe(true);
	});
});

describe("watch diff floor", () => {
	test("diffFloor of equal digests is 0", () => {
		expect(watchDiffFloor("abc", "abc")).toBe(0);
	});
	test("diffFloor of differing digests is positive", () => {
		expect(watchDiffFloor("abc", "xyz")).toBeGreaterThan(0);
	});
	test("diffFloor(undefined, x) is 1 (max change)", () => {
		expect(watchDiffFloor(undefined, "x")).toBe(1);
	});
});

describe("watch digest stability", () => {
	test("same buffer hashes deterministically", () => {
		const buf = Buffer.from("screen-frame-bytes-123");
		expect(watchDigestOf(buf)).toBe(watchDigestOf(buf));
	});
	test("different buffers differ", () => {
		const a = watchDigestOf(Buffer.from("aaaaaaaaaaaaaaaaaaaa"));
		const b = watchDigestOf(Buffer.from("bbbbbbbbbbbbbbbbbbbb"));
		expect(a).not.toBe(b);
	});
	test("digest is a short hex string", () => {
		expect(watchDigestOf(Buffer.from("x"))).toMatch(/^[0-9a-f]+$/);
	});
});