import { describe, expect, it } from "bun:test";
import { parsePageSelector } from "../../src/tools/read-doc";

describe("read_doc parsePageSelector", () => {
	it("parses a single page", () => {
		expect(parsePageSelector("3", 10)).toEqual({ first: 3, last: 3 });
	});

	it("parses a page range", () => {
		expect(parsePageSelector("3-7", 10)).toEqual({ first: 3, last: 7 });
	});

	it("tolerates whitespace around the dash", () => {
		expect(parsePageSelector("3 - 7", 10)).toEqual({ first: 3, last: 7 });
	});

	it("returns undefined for an absent selector (read all)", () => {
		expect(parsePageSelector(undefined, 10)).toBeUndefined();
		expect(parsePageSelector("", 10)).toBeUndefined();
	});

	it("rejects a reversed range", () => {
		expect(parsePageSelector("7-3", 10)).toBeNull();
	});

	it("rejects zero and out-of-range pages", () => {
		expect(parsePageSelector("0", 10)).toBeNull();
		expect(parsePageSelector("11", 10)).toBeNull();
		expect(parsePageSelector("3-12", 10)).toBeNull();
	});

	it("rejects garbage selectors", () => {
		expect(parsePageSelector("all", 10)).toBeNull();
		expect(parsePageSelector("3..7", 10)).toBeNull();
		expect(parsePageSelector("-3", 10)).toBeNull();
	});
});