import { beforeEach, describe, expect, test } from "bun:test";
import {
	DRIVE_LOOP_MAX_FAILURES,
	DRIVE_LOOP_MAX_REPEATS,
	DRIVE_LOOP_MAX_SCROLLS,
	driveLoopAbortReason,
	driveLoopObserve,
	driveLoopStatus,
	resetDriveLoop,
} from "../desktop-control";

beforeEach(() => resetDriveLoop());

describe("drive loop guardrails (clippy parity)", () => {
	test("fresh loop has no abort and zeroed counters", () => {
		expect(driveLoopAbortReason()).toBeNull();
		expect(driveLoopStatus()).toEqual({
			consecutiveFailures: 0,
			lastAction: "",
			repeatCount: 0,
			lastOutcome: "",
			lastScrollDir: "",
			scrollCount: 0,
		});
	});
	test("successes reset the consecutive-failure counter", () => {
		driveLoopObserve("live_click", false);
		driveLoopObserve("live_click", false);
		expect(driveLoopStatus().consecutiveFailures).toBe(2);
		driveLoopObserve("live_click", true);
		expect(driveLoopStatus().consecutiveFailures).toBe(0);
		expect(driveLoopAbortReason()).toBeNull();
	});
	test(`${DRIVE_LOOP_MAX_FAILURES} consecutive failures abort`, () => {
		for (let i = 0; i < DRIVE_LOOP_MAX_FAILURES; i++) driveLoopObserve("live_type", false);
		const reason = driveLoopAbortReason();
		expect(reason).toContain("consecutive failures");
		expect(reason).toContain("re-eye");
	});
	test(`${DRIVE_LOOP_MAX_REPEATS} same-action repeats abort`, () => {
		// Alternate first so the action name's counter restarts cleanly.
		driveLoopObserve("live_move", true);
		for (let i = 0; i < DRIVE_LOOP_MAX_REPEATS; i++) driveLoopObserve("live_click", true);
		const reason = driveLoopAbortReason();
		expect(reason).toContain("live_click");
		expect(reason).toContain("repeated");
	});
	test("switching actions resets the repeat counter", () => {
		driveLoopObserve("live_click", true);
		driveLoopObserve("live_click", true);
		driveLoopObserve("live_move", true);
		expect(driveLoopStatus().repeatCount).toBe(1);
		expect(driveLoopAbortReason()).toBeNull();
	});
	test(`${DRIVE_LOOP_MAX_SCROLLS} same-direction scrolls abort`, () => {
		for (let i = 0; i < DRIVE_LOOP_MAX_SCROLLS; i++) driveLoopObserve("live_scroll", true, "down");
		const reason = driveLoopAbortReason();
		expect(reason).toContain("down");
	});
	test("reversing scroll direction resets the scroll counter", () => {
		for (let i = 0; i < DRIVE_LOOP_MAX_SCROLLS - 1; i++) driveLoopObserve("live_scroll", true, "down");
		driveLoopObserve("live_scroll", true, "up");
		expect(driveLoopStatus().scrollCount).toBe(1);
		expect(driveLoopAbortReason()).toBeNull();
	});
	test("non-scroll actions clear scroll tracking", () => {
		driveLoopObserve("live_scroll", true, "down");
		driveLoopObserve("live_click", true);
		expect(driveLoopStatus().scrollCount).toBe(0);
	});
});