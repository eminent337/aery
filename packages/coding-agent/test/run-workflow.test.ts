import { describe, expect, it } from "bun:test";
import { RunWorkflowTool } from "../src/tools/run-workflow";

describe("RunWorkflowTool (AGY 1.5.9 Parity)", () => {
	const tool = new RunWorkflowTool();

	it("rejects when neither Script nor ScriptPath is provided", async () => {
		await expect(
			tool.execute("call_1", {
				Description: "Missing script",
			}),
		).rejects.toThrow("set exactly one of Script or ScriptPath");
	});

	it("rejects relative Cwd parameter", async () => {
		await expect(
			tool.execute("call_2", {
				Script: "print('hello')",
				Description: "Relative cwd test",
				Cwd: "./relative/dir",
			}),
		).rejects.toThrow("must be an absolute path");
	});

	it("executes script with args, phase, and log primitives", async () => {
		const script = `
phase("Discovery")
log(f"Received target: {args.get('target')}")
total = sum([1, 2, 3, 4, 5])
log(f"Computed total: {total}")
print(f"Result: {total}")
`;

		const res = await tool.execute("call_3", {
			Script: script,
			Description: "Compute sum with log primitives",
			Args: { target: "calculations" },
		});

		expect(res.details.success).toBe(true);
		expect(res.details.logs).toContain("=== Phase: Discovery ===");
		expect(res.details.logs).toContain("Received target: calculations");
		expect(res.details.logs).toContain("Computed total: 15");
		expect(res.details.output).toContain("Result: 15");
	});

	it("executes parallel and pipeline tasks", async () => {
		const script = `
items = ["alpha", "beta", "gamma"]

async def process_item(item):
    log(f"Processing {item}")
    return f"done-{item}"

results = await parallel(items, process_item)
log(f"Parallel results: {results}")

seq_results = await pipeline(["step1", "step2"], process_item)
log(f"Pipeline results: {seq_results}")
print("Workflow tasks finished successfully")
`;

		const res = await tool.execute("call_4", {
			Script: script,
			Description: "Parallel and pipeline workflow",
		});

		expect(res.details.success).toBe(true);
		expect(
			res.details.logs.some(l => l.includes("Parallel results: ['done-alpha', 'done-beta', 'done-gamma']")),
		).toBe(true);
		expect(res.details.logs.some(l => l.includes("Pipeline results: ['done-step1', 'done-step2']"))).toBe(true);
		expect(res.details.output).toContain("Workflow tasks finished successfully");
	});

	it("handles script exceptions cleanly", async () => {
		const script = `
log("Starting doomed task")
raise ValueError("Intentional workflow failure")
`;

		const res = await tool.execute("call_5", {
			Script: script,
			Description: "Error handling workflow",
		});

		expect(res.details.success).toBe(false);
		expect(res.details.output).toContain("ValueError: Intentional workflow failure");
	});
});
