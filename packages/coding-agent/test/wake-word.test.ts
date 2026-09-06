import { describe, expect, it } from "bun:test";
import { detectWakeWord } from "../src/voice/wake-word";

describe("Wake Word Detection (isair/jarvis protocol)", () => {
	it("detects primary wake word at the start of a sentence", () => {
		const res = detectWakeWord("Aerys, what are the files in this directory?");
		expect(res.detected).toBe(true);
		expect(res.query.toLowerCase()).toBe("what are the files in this directory?");
	});

	it("detects Aery variant", () => {
		const res = detectWakeWord("Aery, can you hear me clearly?");
		expect(res.detected).toBe(true);
		expect(res.query.toLowerCase()).toBe("can you hear me clearly?");
	});

	it("detects phonetic variation (Aries / Airy)", () => {
		const res1 = detectWakeWord("Aries, open the terminal");
		expect(res1.detected).toBe(true);
		expect(res1.query.toLowerCase()).toBe("open the terminal");

		const res2 = detectWakeWord("Airy, what's on my screen?");
		expect(res2.detected).toBe(true);
		expect(res2.query.toLowerCase()).toBe("what's on my screen?");
	});

	it("detects wake word at the end of a sentence", () => {
		const res = detectWakeWord("What is the time right now, Aerys?");
		expect(res.detected).toBe(true);
		expect(res.query.toLowerCase()).toBe("what is the time right now?");
	});

	it("handles wake word spoken alone", () => {
		const res = detectWakeWord("Aerys");
		expect(res.detected).toBe(true);
		expect(res.query).toBe("");
	});

	it("ignores background conversation without wake word", () => {
		const res1 = detectWakeWord("I am having lunch right now with Bob");
		expect(res1.detected).toBe(false);
		expect(res1.query).toBe("");

		const res2 = detectWakeWord("That video was really funny");
		expect(res2.detected).toBe(false);
		expect(res2.query).toBe("");
	});
});
