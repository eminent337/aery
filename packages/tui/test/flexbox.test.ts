import { describe, expect, it } from "bun:test";
import { FlexBox } from "../src/components/flexbox";

class Fake {
	constructor(private lines: string[]) {}
	render(_w: number) {
		return this.lines;
	}
	invalidate() {}
}

describe("FlexBox", () => {
	it("row: splits width proportionally by grow", () => {
		const a = new Fake(["AAAA"]);
		const b = new Fake(["BBBBBBBB"]);
		const box = new FlexBox({ direction: "row", gap: 0 });
		box.addItem(a, { grow: 1 });
		box.addItem(b, { grow: 2 });
		const result = box.render(30);
		expect(result).toHaveLength(1);
		expect(result[0]).toContain("AAAA");
		expect(result[0]).toContain("BBBBBBBB");
	});

	it("row: respects fixed width", () => {
		const a = new Fake(["AA"]);
		const b = new Fake(["BBBB"]);
		const box = new FlexBox({ direction: "row", gap: 0 });
		box.addItem(a, { fixed: 10 });
		box.addItem(b, { grow: 1 });
		const result = box.render(30);
		expect(result).toHaveLength(1);
	});

	it("row: gap adds space between columns", () => {
		const a = new Fake(["A"]);
		const b = new Fake(["B"]);
		const box = new FlexBox({ direction: "row", gap: 2 });
		box.addItem(a, { grow: 1 });
		box.addItem(b, { grow: 1 });
		const result = box.render(22);
		expect(result[0]!.length).toBeGreaterThanOrEqual(20);
	});

	it("column: stacks children vertically", () => {
		const a = new Fake(["line1"]);
		const b = new Fake(["line2"]);
		const box = new FlexBox({ direction: "column" });
		box.addItem(a, { grow: 1 });
		box.addItem(b, { grow: 1 });
		const result = box.render(20);
		expect(result).toEqual(["line1", "line2"]);
	});

	it("row: zips unequal-height children with empty fill", () => {
		const a = new Fake(["A1", "A2", "A3"]);
		const b = new Fake(["B1"]);
		const box = new FlexBox({ direction: "row", gap: 0 });
		box.addItem(a, { grow: 1 });
		box.addItem(b, { grow: 1 });
		const result = box.render(20);
		expect(result).toHaveLength(3);
	});

	it("invalidate propagates to children", () => {
		let hit = false;
		const c = {
			render: () => [],
			invalidate: () => {
				hit = true;
			},
		};
		const box = new FlexBox({ direction: "row" });
		box.addItem(c, { grow: 1 });
		box.invalidate();
		expect(hit).toBe(true);
	});
});
