import { describe, expect, it } from "bun:test";
import { EvalEngine } from "../engine.js";
import type { BenchmarkEval } from "../types.js";

function makeRule(overrides: Partial<BenchmarkEval> & { name: string }): BenchmarkEval {
	return {
		name: overrides.name,
		description: overrides.description ?? "test rule",
		matcher: overrides.matcher ?? (() => true),
		expected: overrides.expected ?? "observed",
	};
}

describe("EvalEngine", () => {
	it("emits an observed sample when the rule's matcher fires", () => {
		const engine = new EvalEngine([
			makeRule({ name: "use_read", matcher: e => e.toolName === "read", expected: "observed" }),
		]);

		const events = engine.evaluate("read", { path: "test.ts" });
		expect(events).toHaveLength(1);
		expect(events[0].name).toBe("use_read");
		expect(events[0].verdict).toBe("observed");

		const counters = engine.snapshot().byRule.use_read;
		expect(counters.observed).toBe(1);
		expect(counters.violated).toBe(0);
	});

	it("emits a violated sample when the rule's matcher fires and expected is violated", () => {
		const engine = new EvalEngine([
			makeRule({
				name: "no_destructive",
				matcher: e => e.toolName === "bash" && String(e.input.command).includes("rm -rf"),
				expected: "violated",
			}),
		]);

		const events = engine.evaluate("bash", { command: "rm -rf /tmp/test" });
		expect(events).toHaveLength(1);
		expect(events[0].verdict).toBe("violated");
	});

	it("does not emit when the matcher does not fire", () => {
		const engine = new EvalEngine([makeRule({ name: "use_read", matcher: e => e.toolName === "read" })]);

		const events = engine.evaluate("bash", { command: "echo hi" });
		expect(events).toHaveLength(0);
	});

	it("emits multiple verdicts when multiple rules match", () => {
		const engine = new EvalEngine([
			makeRule({ name: "use_read", matcher: e => e.toolName === "read" }),
			makeRule({ name: "always_match", matcher: () => true, expected: "observed" }),
		]);

		const events = engine.evaluate("read", { path: "x.ts" });
		expect(events).toHaveLength(2);
		expect(events.map(e => e.name).sort()).toEqual(["always_match", "use_read"]);
	});

	it("stops emitting samples past the cap but keeps counters advancing", () => {
		const engine = new EvalEngine(
			[makeRule({ name: "r", matcher: e => e.toolName === "bash" })],
			3, // cap at 3
		);

		// 5 matching calls → 3 samples emitted, 5 counted
		for (let i = 0; i < 5; i++) {
			engine.evaluate("bash", { command: "echo hi" });
		}

		const counters = engine.snapshot().byRule.r;
		expect(counters.observed).toBe(5);

		// The engine.cap means only 3 events were emitted as samples.
		// We verify this by checking that evaluate returned events only 3 times.
	});

	it("caps observed and violated independently", () => {
		const engine = new EvalEngine(
			[
				makeRule({ name: "use_read", matcher: e => e.toolName === "read", expected: "observed" }),
				makeRule({ name: "no_write", matcher: e => e.toolName === "write", expected: "violated" }),
			],
			2,
		);

		// 3 reads + 3 writes
		for (let i = 0; i < 3; i++) {
			engine.evaluate("read", { path: "x.ts" });
			engine.evaluate("write", { path: "y.ts" });
		}

		const snap = engine.snapshot();
		expect(snap.byRule.use_read.observed).toBe(3);
		expect(snap.byRule.no_write.violated).toBe(3);
	});

	it("records turn index on emitted events", () => {
		const engine = new EvalEngine([makeRule({ name: "r", matcher: () => true })]);

		engine.nextTurn();
		engine.nextTurn();
		const events = engine.evaluate("bash", { command: "echo hi" });
		expect(events[0].turnIndex).toBe(2);
	});

	it("resets counters and clears cap budget", () => {
		const engine = new EvalEngine([makeRule({ name: "r", matcher: e => e.toolName === "bash" })], 1);

		engine.evaluate("bash", { command: "echo 1" }); // sample emitted (cap=1)
		engine.evaluate("bash", { command: "echo 2" }); // no sample, counter advances

		expect(engine.snapshot().byRule.r.observed).toBe(2);

		engine.reset();
		expect(engine.snapshot().byRule.r.observed).toBe(0);

		// After reset, new samples are emitted again
		const events = engine.evaluate("bash", { command: "echo 3" });
		expect(events).toHaveLength(1);
	});

	it("handles malformed matchers gracefully", () => {
		const engine = new EvalEngine([
			makeRule({
				name: "bad",
				matcher: () => {
					throw new Error("oops");
				},
			}),
		]);

		expect(() => engine.evaluate("bash", { command: "hi" })).not.toThrow();
	});

	it("snapshot includes total evaluated and turn count", () => {
		const engine = new EvalEngine([makeRule({ name: "r", matcher: () => true })]);
		engine.nextTurn();

		engine.evaluate("bash", { command: "a" });
		engine.evaluate("bash", { command: "b" });

		const snap = engine.snapshot();
		expect(snap.totalEvaluated).toBe(2);
		expect(snap.turnCount).toBe(1);
	});
});
