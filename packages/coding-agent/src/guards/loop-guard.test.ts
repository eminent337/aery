import { describe, expect, it } from "vitest";
import { LoopGuard } from "./loop-guard";

describe("LoopGuard", () => {
	it("detects 3 consecutive identical tool calls", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("read", { file: "a.ts" }, false, "output-a");
		guard.record("read", { file: "a.ts" }, false, "output-a");
		const result = guard.check("read", { file: "a.ts" }, false, "output-a");
		expect(result.state).toBe("warn");
	});

	it("terminates on repeated warn", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("read", { file: "a.ts" }, false, "output-a");
		guard.record("read", { file: "a.ts" }, false, "output-a");
		guard.check("read", { file: "a.ts" }, false, "output-a"); // warn
		const result = guard.check("read", { file: "a.ts" }, false, "output-a"); // terminate
		expect(result.state).toBe("terminate");
	});

	it("does not trigger on varied tools", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("read", { file: "a.ts" }, false, "out");
		guard.record("edit", { file: "a.ts" }, false, "out");
		guard.record("bash", { command: "npm test" }, false, "out");
		const result = guard.check("bash", { command: "npm test" }, false, "out");
		expect(result.state).toBe("ok");
	});

	it("resets streak when pattern breaks", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("read", { file: "a.ts" }, false, "out");
		guard.record("read", { file: "b.ts" }, false, "out");
		guard.record("edit", { file: "c.ts" }, false, "out"); // breaks
		guard.record("read", { file: "d.ts" }, false, "out");
		guard.record("read", { file: "e.ts" }, false, "out");
		const result = guard.check("read", { file: "f.ts" }, false, "out");
		expect(result.state).toBe("ok");
	});

	it("reports readable pattern", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("bash", { command: "npm test" }, false, "out");
		guard.record("bash", { command: "npm test" }, false, "out");
		const result = guard.check("bash", { command: "npm test" }, false, "out");
		expect(guard.getPattern()).toContain("bash");
	});

	it("detects 2-gram repeat (exact)", () => {
		const guard = new LoopGuard({
			consecutiveThreshold: 10,
			ngramSize: 2,
			ngramThreshold: 6,
		});
		// Repeat read→edit 6 times with identical output
		for (let i = 0; i < 5; i++) {
			guard.record("read", { file: "a.ts" }, false, "same-output");
			guard.record("edit", { file: "a.ts" }, false, "same-output");
		}
		// 6th cycle triggers
		guard.record("read", { file: "a.ts" }, false, "same-output");
		const result = guard.record("edit", { file: "a.ts" }, false, "same-output");
		expect(result.state).toBe("warn");
	});

	it("reset() clears all state", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("read", { file: "a.ts" }, false, "out");
		guard.record("read", { file: "a.ts" }, false, "out");
		guard.reset();
		const result = guard.check("read", { file: "a.ts" }, false, "out");
		expect(result.state).toBe("ok");
	});

	it("errors count toward loop detection", () => {
		const guard = new LoopGuard({ consecutiveThreshold: 3 });
		guard.record("bash", { command: "rm -rf /" }, true, "permission denied");
		guard.record("bash", { command: "rm -rf /" }, true, "permission denied");
		const result = guard.check("bash", { command: "rm -rf /" }, true, "permission denied");
		expect(result.state).toBe("warn");
	});
});
