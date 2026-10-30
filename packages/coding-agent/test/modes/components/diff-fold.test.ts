import { beforeAll, describe, expect, it } from "bun:test";
import { renderDiff } from "../../../src/modes/components/diff";
import { initTheme } from "../../../src/modes/theme/theme";

describe("renderDiff context folding", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("does not fold context runs of 15 or fewer lines", () => {
		const contextLines = Array.from({ length: 12 }, (_, i) => ` ${i + 1}|const x${i} = ${i};`).join("\n");
		const diff = `${contextLines}\n+ 13|const final = true;`;

		const output = renderDiff(diff);
		expect(output).not.toContain("unchanged lines");
		expect(output).toContain("const x0 = 0;");
		expect(output).toContain("const x11 = 11;");
		expect(output).toContain("const final = true;");
	});

	it("folds context runs of more than 15 lines into first 3, collapse marker, and last 3", () => {
		// 20 context lines + 1 added line
		const contextLines = Array.from({ length: 20 }, (_, i) => ` ${i + 1}|const line${i + 1} = true;`).join("\n");
		const diff = `${contextLines}\n+ 21|const added = "hello";`;

		const output = renderDiff(diff);
		// Skipped lines = 20 - 6 = 14
		expect(output).toContain("··· 14 unchanged lines ···");

		// First 3 lines must be present
		expect(output).toContain("line1");
		expect(output).toContain("line2");
		expect(output).toContain("line3");

		// Middle line (e.g. line10) must be skipped
		expect(output).not.toContain("line10");

		// Last 3 lines must be present
		expect(output).toContain("line18");
		expect(output).toContain("line19");
		expect(output).toContain("line20");

		// Added line must be present
		expect(output).toContain("const added = \"hello\";");
	});

	it("preserves all context lines when options.expanded is true", () => {
		const contextLines = Array.from({ length: 25 }, (_, i) => ` ${i + 1}|const item${i + 1} = ${i + 1};`).join("\n");
		const diff = `${contextLines}\n- 26|const oldVal = 1;\n+ 26|const newVal = 2;`;

		const output = renderDiff(diff, { expanded: true });
		expect(output).not.toContain("unchanged lines");
		expect(output).toContain("item1");
		expect(output).toContain("item12");
		expect(output).toContain("item25");
		expect(output).toContain("newVal");
	});
});
