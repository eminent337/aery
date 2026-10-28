import { describe, expect, it } from "bun:test";
import {
	type ClickTarget,
	clickTargetsFromOcr,
	framesCoherent,
	hoverTargetAt,
	type InputFrame,
	isJunkTargetWord,
	type OcrWordBox,
	rememberClickTargets,
	resolveClickTarget,
} from "../src/tools/desktop-control";
import { type EyeWindow, eyeMarkPresent, shouldUseFocusedFrame } from "../src/tools/live-eye";

describe("Live Eye Enhancements & Focus-First Defaults (AGY Parity)", () => {
	const sampleWindow: EyeWindow = {
		at: [100, 150],
		size: [600, 400],
		title: "Editor - Aery",
		class: "code",
	};

	it("defaults focusFirst to true when omitted, framing active window", () => {
		// When focusFirst is omitted or true, it upgrades fullscreen target to the active window
		expect(shouldUseFocusedFrame("fullscreen", true, sampleWindow)).toBe(true);
		expect(shouldUseFocusedFrame("fullscreen", undefined, sampleWindow)).toBe(true);

		// When focusFirst is explicitly false, it does not upgrade
		expect(shouldUseFocusedFrame("fullscreen", false, sampleWindow)).toBe(false);
	});

	it("does not rewrite explicit targets even with focusFirst", () => {
		expect(shouldUseFocusedFrame("active_window", true, sampleWindow)).toBe(false);
		expect(shouldUseFocusedFrame("firefox", true, sampleWindow)).toBe(false);
		expect(shouldUseFocusedFrame("terminal", true, sampleWindow)).toBe(false);
	});

	it("falls back to fullscreen if focused window has degenerate geometry", () => {
		const zeroWin: EyeWindow = { at: [0, 0], size: [0, 0] };
		const negWin: EyeWindow = { at: [0, 0], size: [-10, 200] };
		const noSizeWin: EyeWindow = { at: [0, 0] };

		expect(shouldUseFocusedFrame("fullscreen", true, zeroWin)).toBe(false);
		expect(shouldUseFocusedFrame("fullscreen", true, negWin)).toBe(false);
		expect(shouldUseFocusedFrame("fullscreen", true, noSizeWin)).toBe(false);
		expect(shouldUseFocusedFrame("fullscreen", true, undefined)).toBe(false);
	});

	it("identifies liveEye markers in result details", () => {
		expect(eyeMarkPresent({ liveEye: { at: 123456 } })).toBe(true);
		expect(eyeMarkPresent({ liveEye: {} })).toBe(true);
		expect(eyeMarkPresent({})).toBe(false);
		expect(eyeMarkPresent(null)).toBe(false);
		expect(eyeMarkPresent({ otherTool: true })).toBe(false);
	});

	it("resolves OCR click-target word boundaries correctly", () => {
		const frame: InputFrame = {
			kind: "window",
			address: "0x123",
			atX: 0,
			atY: 0,
			physW: 1280,
			physH: 800,
			scaledW: 1280,
			scaledH: 800,
		};

		const words: OcrWordBox[] = [
			{ text: "Send", x: 100, y: 100, w: 60, h: 24, confidence: 0.95 },
			{ text: "Sender", x: 200, y: 100, w: 70, h: 24, confidence: 0.95 },
			{ text: "Resend", x: 300, y: 100, w: 70, h: 24, confidence: 0.95 },
			{ text: "Send Message Now", x: 100, y: 200, w: 180, h: 24, confidence: 0.9 },
		];

		const targets = clickTargetsFromOcr(words, frame);
		expect(targets.length).toBe(4);

		// Anchor targets into click resolver
		rememberClickTargets(targets, frame);

		// Exact match (tier 0) -> "Send" should hit the exact "Send" button, not "Sender" or "Resend"
		const hitExact = resolveClickTarget("Send");
		expect(hitExact).not.toBeNull();
		expect(hitExact?.box.text).toBe("Send");
		expect(hitExact?.x).toBe(130); // 100 + 60/2
		expect(hitExact?.y).toBe(112); // 100 + 24/2

		// Word boundary match (tier 1) -> "Message" should match "Send Message Now"
		const hitWord = resolveClickTarget("Message");
		expect(hitWord).not.toBeNull();
		expect(hitWord?.box.text).toBe("Send Message Now");

		// "End" substring should not match "Send" as a word boundary
		const hitSub = resolveClickTarget("end");
		expect(hitSub).not.toBeNull();
		// In tier 2 (substring), shorter text wins
		expect(hitSub?.box.text).toBe("Send");
	});

	it("filters junk words and maintains frame coherence", () => {
		expect(isJunkTargetWord("Submit", 0.5)).toBe(false); // contains letters
		expect(isJunkTargetWord("77", 0.4)).toBe(false); // contains digits
		expect(isJunkTargetWord("...", 0.4)).toBe(true); // symbol with low confidence
		expect(isJunkTargetWord("+", 0.8)).toBe(false); // high confidence symbol survives

		const frameA: InputFrame = {
			kind: "window",
			address: "0x111",
			atX: 0,
			atY: 0,
			physW: 1000,
			physH: 800,
			scaledW: 1000,
			scaledH: 800,
		};

		const frameB: InputFrame = { ...frameA };
		expect(framesCoherent(frameA, frameB)).toBe(true);

		const frameC: InputFrame = { ...frameA, address: "0x222" };
		expect(framesCoherent(frameA, frameC)).toBe(false);
	});

	it("identifies hover target under pointer coordinates", () => {
		const targets: ClickTarget[] = [
			{ text: "Outer Panel", x: 10, y: 10, w: 300, h: 200, confidence: 0.9 },
			{ text: "OK Button", x: 50, y: 50, w: 80, h: 30, confidence: 0.95 },
		];

		// Hover inside OK Button: smallest containing box wins
		const hitButton = hoverTargetAt({ x: 70, y: 60 }, targets);
		expect(hitButton).not.toBeNull();
		expect(hitButton?.text).toBe("OK Button");

		// Hover inside Outer Panel but outside OK Button
		const hitPanel = hoverTargetAt({ x: 200, y: 150 }, targets);
		expect(hitPanel).not.toBeNull();
		expect(hitPanel?.text).toBe("Outer Panel");

		// Hover outside everything
		const hitNothing = hoverTargetAt({ x: 500, y: 500 }, targets);
		expect(hitNothing).toBeNull();
	});
});
