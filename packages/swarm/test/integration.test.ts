import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmSupervisor } from "../src/supervisor/swarm-supervisor";

describe("Native Swarm End-to-End Integration", () => {
	it("executes full collaborative workflow across coordinator and worker", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "swarm-e2e-"));
		const supervisor = new SwarmSupervisor({
			swarmId: "e2e-session",
			storageDir: testDir,
			coordinatorModel: "gemini-3.6-flash",
		});

		try {
			const coordinatorTools = supervisor.getToolsFor("coordinator");
			const swarmTool = coordinatorTools.find((t) => t.name === "swarm")!;
			const postTool = coordinatorTools.find((t) => t.name === "post_message")!;

			// 1. Coordinator adds worker
			const addRes = await swarmTool.execute({
				action: "add",
				name: "worker-1",
				brief: "Compute metrics",
				workspace: "inherit",
			});
			expect(addRes.success).toBe(true);

			// 2. Coordinator posts task
			await postTool.execute({
				content: "@worker-1 calculate memory footprint",
			});

			// 3. Worker reads board
			const workerTools = supervisor.getToolsFor("worker-1");
			const readTool = workerTools.find((t) => t.name === "read_board")!;
			const readRes = await readTool.execute({ mentionsOnlyFor: "worker-1" });
			expect(readRes.messages).toHaveLength(1);
			expect(readRes.messages[0].content).toContain("calculate memory footprint");

			// 4. Worker posts completion
			const workerPost = workerTools.find((t) => t.name === "post_message")!;
			await workerPost.execute({
				content: "@coordinator metrics computed: 42MB used",
			});

			// 5. Coordinator verifies response
			const coordRead = coordinatorTools.find((t) => t.name === "read_board")!;
			const coordRes = await coordRead.execute({ mentionsOnlyFor: "coordinator" });
			expect(coordRes.messages).toHaveLength(1);
			expect(coordRes.messages[0].content).toContain("42MB used");
		} finally {
			supervisor.destroy();
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
