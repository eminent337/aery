import { beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@aryee337/aery/async/job-manager";
import { BashOutputTool } from "@aryee337/aery/tools/bash-output";

describe("bash_output", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({
			onJobComplete: () => {},
		});
		AsyncJobManager.setInstance(manager);
	});

	it("returns null for non-existent job", () => {
		const result = manager.readOutput("does_not_exist");
		expect(result).toBeNull();
	});

	it("reads accumulated output", () => {
		const id = manager.register("bash", "test", async ({ reportProgress }) => {
			await reportProgress("line 1\n");
			await reportProgress("line 2\n");
			return "done";
		});

		// Read initial output
		const result1 = manager.readOutput(id);
		expect(result1).not.toBeNull();
		expect(result1!.text).toContain("line 1");
		expect(result1!.status).toBe("running");
		expect(result1!.done).toBe(false);

		// Read again — should get empty string (no new output)
		const result2 = manager.readOutput(id);
		expect(result2).not.toBeNull();
		expect(result2!.text).toBe("");
	});

	it("returns final output on completion", async () => {
		const id = manager.register("bash", "test", async ({ reportProgress }) => {
			await reportProgress("building...\n");
			await reportProgress("success\n");
			return "done";
		});

		// Wait for completion
		await manager.waitForAll();

		const result = manager.readOutput(id);
		expect(result).not.toBeNull();
		expect(result!.status).toBe("completed");
		expect(result!.done).toBe(true);
		expect(result!.text).toContain("success");
	});

	it("BashOutputTool returns error without manager", async () => {
		AsyncJobManager.setInstance(undefined);
		const tool = new BashOutputTool({} as never);
		const result = await tool.execute("call_1", { jobId: "bg_1" });
		const firstContent = result.content[0];
		if (firstContent && "text" in firstContent) {
			expect(firstContent.text).toContain("unavailable");
		} else {
			throw new Error("Expected text content");
		}
	});

	it("BashOutputTool returns error for non-existent job", async () => {
		const tool = new BashOutputTool({} as never);
		const result = await tool.execute("call_1", { jobId: "does_not_exist" });
		const firstContent = result.content[0];
		if (firstContent && "text" in firstContent) {
			expect(firstContent.text).toContain("No active background job");
		} else {
			throw new Error("Expected text content");
		}
	});
});
