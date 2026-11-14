import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/store/board-store";
import { MemberRegistry } from "../src/store/member-registry";
import { WakeEngine } from "../src/wake/wake-engine";
import { WorktreeManager } from "../src/workspace/worktree-manager";
import { createSwarmTool } from "../src/tools/swarm-tool";
import { createPostMessageTool } from "../src/tools/post-message-tool";
import { createReadBoardTool } from "../src/tools/read-board-tool";
import { createSwarmWaitTool } from "../src/tools/swarm-wait-tool";

describe("Swarm Tools", () => {
	let testDir: string;
	let boardStore: BoardStore;
	let registry: MemberRegistry;
	let wakeEngine: WakeEngine;
	let worktreeManager: WorktreeManager;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "swarm-tools-"));
		boardStore = new BoardStore(testDir);
		registry = new MemberRegistry(testDir);
		wakeEngine = new WakeEngine();
		worktreeManager = new WorktreeManager(testDir, "test-session");
	});

	afterEach(() => {
		worktreeManager.cleanupAll();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executes swarm tool status, add, and kill actions", async () => {
		const swarmTool = createSwarmTool({ registry, worktreeManager });

		const addRes = await swarmTool.execute({
			action: "add",
			name: "engineer-1",
			brief: "Build API",
			workspace: "inherit",
		});
		expect(addRes.success).toBe(true);
		expect(registry.getMember("engineer-1")?.brief).toBe("Build API");

		const statusRes = await swarmTool.execute({ action: "status" });
		expect(statusRes.members).toHaveLength(1);

		const killRes = await swarmTool.execute({ action: "kill", name: "engineer-1" });
		expect(killRes.success).toBe(true);
		expect(registry.getMember("engineer-1")?.state).toBe("killed");
	});

	it("posts and reads board messages", async () => {
		const postTool = createPostMessageTool({ boardStore, wakeEngine, callerName: "coordinator" });
		const readTool = createReadBoardTool({ boardStore, registry, callerName: "engineer-1" });

		await postTool.execute({ content: "@engineer-1 please review" });

		const readRes = await readTool.execute({});
		expect(readRes.messages).toHaveLength(1);
		expect(readRes.messages[0].content).toContain("@engineer-1");
	});

	it("swarm_wait wakes when message arrives", async () => {
		const waitTool = createSwarmWaitTool({ wakeEngine, callerName: "worker-1" });
		const waitPromise = waitTool.execute({ timeoutMs: 3000 });

		wakeEngine.notifyMessage({
			seq: 1,
			timestamp: new Date().toISOString(),
			from: "coordinator",
			mentions: ["worker-1"],
			content: "@worker-1 wake up",
		});

		const res = await waitPromise;
		expect(res.woken).toBe(true);
		expect(res.messages).toHaveLength(1);
	});
});
