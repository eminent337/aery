import { describe, expect, test } from "bun:test";
import { parseTsvWordBoxes, textFromTsvWords } from "../screen-ocr";

const TSV = `level	page	block	par	line	word	left	top	width	height	conf	text
5	1	1	1	1	1	100	200	120	30	92.5	Compose
5	1	1	1	1	2	500	300	80	26	88	Send
5	1	1	1	1	3	200	400	140	24	75.1	Subject
5	1	1	1	1	4	-5	50	20	10	80	neg
5	1	1	1	1	5	10	10	0	10	80	zerow
5	1	1	1	1	6	10	10	10	0	80	zeroh
4	1	1	1	1	7	10	10	10	10	80	notword`;

describe("parseTsvWordBoxes", () => {
	test("parses word rows into boxes with text + geometry + confidence", () => {
		const boxes = parseTsvWordBoxes(TSV);
		const compose = boxes.find(b => b.text === "Compose");
		expect(compose).toBeDefined();
		expect(compose?.x).toBe(100);
		expect(compose?.y).toBe(200);
		expect(compose?.w).toBe(120);
		expect(compose?.h).toBe(30);
		expect(compose?.confidence).toBeCloseTo(0.93, 1);
		expect(boxes.length).toBe(4); // Compose, Send, Subject, neg
	});
	test("drops non-word levels (paragraph/line rows)", () => {
		const boxes = parseTsvWordBoxes(TSV);
		expect(boxes.some(b => b.text === "notword")).toBe(false);
	});
	test("keeps negative-left boxes (coordinates fold back later at clamp)", () => {
		const boxes = parseTsvWordBoxes(TSV);
		const neg = boxes.find(b => b.text === "neg");
		expect(neg?.x).toBe(-5);
	});
	test("drops zero-area and non-finite boxes", () => {
		const boxes = parseTsvWordBoxes(TSV);
		expect(boxes.some(b => b.text === "zerow")).toBe(false);
		expect(boxes.some(b => b.text === "zeroh")).toBe(false);
	});
	test("divisor folds an upscaled pass back to native pixels", () => {
		const boxes = parseTsvWordBoxes(TSV, 2);
		const compose = boxes.find(b => b.text === "Compose");
		expect(compose?.x).toBe(50);
		expect(compose?.y).toBe(100);
		expect(compose?.w).toBe(60);
		expect(compose?.h).toBe(15);
	});
	test("returns [] for empty / header-only input", () => {
		expect(parseTsvWordBoxes("")).toEqual([]);
		expect(parseTsvWordBoxes("level\tpage\tblock")).toEqual([]);
	});
});

describe("textFromTsvWords", () => {
	// Same visual block: three lines of words, TSV emits them in reading order
	// but the middle line's words are x-sorted out of order on purpose.
	const MULTILINE = `level	page	block	par	line	word	left	top	width	height	conf	text
5	1	1	1	1	1	100	10	60	20	95	Hello
5	1	1	1	1	2	170	10	60	20	95	world
5	1	1	1	2	1	100	40	60	20	93	Second
5	1	1	1	2	2	170	40	60	20	93	line
5	1	1	1	3	1	100	70	60	20	91	Third
5	1	1	1	3	2	170	70	60	20	91	line`;

	test("rebuilds the reading in line order, left-to-right within a line", () => {
		const text = textFromTsvWords(parseTsvWordBoxes(MULTILINE));
		expect(text).toBe("Hello world\nSecond line\nThird line");
	});

	test("keeps paragraph and block boundaries as separate lines", () => {
		const TWO_BLOCKS = `level	page	block	par	line	word	left	top	width	height	conf	text
5	1	1	1	1	1	10	10	50	18	90	Alpha
5	1	2	1	1	1	10	90	50	18	90	Beta`;
		const text = textFromTsvWords(parseTsvWordBoxes(TWO_BLOCKS));
		expect(text).toBe("Alpha\nBeta");
	});

	test("returns '' for no words so callers can distinguish empty from failure", () => {
		expect(textFromTsvWords([])).toBe("");
	});

	test("falls back to a vertical bucket when a box carries no lineKey", () => {
		// Synthesized boxes (no TSV origin) must still reconstruct, not throw.
		const boxes: Array<{ text: string; x: number; y: number; w: number; h: number; confidence: number }> = [
			{ text: "one", x: 0, y: 0, w: 40, h: 20, confidence: 0.9 },
			{ text: "two", x: 50, y: 2, w: 40, h: 20, confidence: 0.9 },
			{ text: "next", x: 0, y: 100, w: 40, h: 20, confidence: 0.9 },
		];
		expect(textFromTsvWords(boxes)).toBe("one two\nnext");
	});

	test("orders lines top-to-bottom even when TSV emitted them out of order", () => {
		const SHUFFLED = `level	page	block	par	line	word	left	top	width	height	conf	text
5	1	1	1	2	1	100	60	60	20	95	Lower
5	1	1	1	1	1	100	10	60	20	95	Upper`;
		const text = textFromTsvWords(parseTsvWordBoxes(SHUFFLED));
		expect(text).toBe("Upper\nLower");
	});
});

describe("ocrFrame never silently discards produced text", () => {
	test("when tesseract succeeds, the returned text and words are non-empty", async () => {
		const { ocrFrame } = await import("../screen-ocr");
		const util = await import("node:util");
		const exec = util.promisify((await import("node:child_process")).execFile);
		// Synthesize a crisp frame: big black-on-white words, no desktop needed.
		const img = "/tmp/ocr-smoke.png";
		await exec("convert", [
			"-size",
			"800x300",
			"xc:white",
			"-font",
			"FreeSans",
			"-pointsize",
			"48",
			"-fill",
			"black",
			"-annotate",
			"+60+120",
			"Cookie Bank Store",
			img,
		]);
		const r = await ocrFrame(img);
		expect(r.error).toBeUndefined();
		expect(r.text.length).toBeGreaterThan(10);
		expect(r.words?.length ?? 0).toBeGreaterThan(1);
		// Canonical contract: every confidence is a 0..1 fraction.
		for (const w of r.words ?? []) {
			expect(w.confidence).toBeGreaterThanOrEqual(0);
			expect(w.confidence).toBeLessThanOrEqual(1);
		}
	});
});
