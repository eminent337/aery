import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../async/job-manager";
import { ManageTaskTool } from "../manage-task";

describe("ManageTaskTool (ported from agy)", () => {
	it("lists running background tasks", async () => {
		const tool = new ManageTaskTool();
		const result = await tool.execute("call-1", { Action: "list" });

		expect(result.content).toBeDefined();
		expect(result.content[0].text).toContain("Background Tasks");
	});

	it("handles status check requiring TaskId", async () => {
		const tool = new ManageTaskTool();
		const result = await tool.execute("call-status-missing", { Action: "status" });

		expect(result.content[0].text).toContain("TaskId is required");
	});

	it("handles status check for nonexistent task gracefully", async () => {
		const tool = new ManageTaskTool();
		const result = await tool.execute("call-2", { Action: "status", TaskId: "nonexistent-task-999" });

		expect(result.content[0].text).toContain("not found");
	});

	it("handles kill action requiring TaskId", async () => {
		const tool = new ManageTaskTool();
		const result = await tool.execute("call-3", { Action: "kill" });

		expect(result.content[0].text).toContain("TaskId is required");
	});

	it("handles send_input validations and nonexistent task", async () => {
		const tool = new ManageTaskTool();
		const missingId = await tool.execute("call-4", { Action: "send_input" });
		expect(missingId.content[0].text).toContain("TaskId is required");

		const missingInput = await tool.execute("call-5", { Action: "send_input", TaskId: "task-1" });
		expect(missingInput.content[0].text).toContain("Input is required");

		const notFound = await tool.execute("call-6", { Action: "send_input", TaskId: "task-1", Input: "hello" });
		expect(notFound.content[0].text).toContain("not found");
	});

	it("operates with an active AsyncJobManager instance", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: () => {},
		});
		AsyncJobManager.setInstance(manager);

		try {
			const jobId = manager.register("task", "test-job", async ({ signal }) => {
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve("done"), 5000);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					});
				});
			});

			const tool = new ManageTaskTool();

			// Test list contains active task
			const listRes = await tool.execute("call-list", { Action: "list" });
			expect(listRes.content[0].text).toContain(jobId);
			expect(listRes.content[0].text).toContain("test-job");

			// Test status contains active task
			const statusRes = await tool.execute("call-status", { Action: "status", TaskId: jobId });
			expect(statusRes.content[0].text).toContain("running");
			expect(statusRes.content[0].text).toContain("test-job");

			// Test kill
			const killRes = await tool.execute("call-kill", { Action: "kill", TaskId: jobId });
			expect(killRes.content[0].text).toContain("terminated");

			// Verify status after kill
			const statusAfter = await tool.execute("call-status-2", { Action: "status", TaskId: jobId });
			expect(statusAfter.content[0].text).toContain("cancelled");
		} finally {
			AsyncJobManager.resetForTests();
		}
	});
});
