import { describe, expect, it } from "bun:test";
import { getBundledAgent } from "../../src/task/agents";

describe("bundled spec-reviewer", () => {
	it("registers spec-reviewer agent", () => {
		const agent = getBundledAgent("spec-reviewer");
		expect(agent).toBeDefined();
		expect(agent?.name).toBe("spec-reviewer");
	});
});
