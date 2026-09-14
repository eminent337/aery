import { describe, expect, test } from "bun:test";
import { parseTsvWordBoxes } from "../screen-ocr";

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