import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setAgentDir } from "@aryee337/aery-utils";
import { SwarmScheduler } from "../../src/task/swarm/scheduler";
import { type PersistedSwarm, SwarmStore } from "../../src/task/swarm/store";
import type { SwarmTask, SwarmWorkflow } from "../../src/task/swarm/types";

let testDir = path.join("/tmp", `swarm-persist-test-${Math.random().toString(36).slice(2)}`);
let repoRoot = "";

function workflow(tasks: SwarmTask[]): SwarmWorkflow {
	return { name: "Test", tasks };
}

describe("SwarmStore persistence", () => {
	beforeEach(() => {
		testDir = path.join("/tmp", `swarm-persist-test-${Math.random().toString(36).slice(2)}`);
		repoRoot = path.join(testDir, "repo");
		fs.mkdirSync(repoRoot, { recursive: true });
		// Redirect the agent DB (and thus SwarmStore's default path) into a
		// fresh temp dir so tests never touch the real ~/.aery/agent DB.
		setAgentDir(testDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("round-trips taskStates and completedBranches through an active row", () => {
		const swarm: PersistedSwarm = {
			id: "swarm-1",
			workflow: workflow([
				{ id: "a", agent: "task", assignment: "A" },
				{ id: "b", agent: "task", assignment: "B", needs: ["a"] },
			]),
			taskStates: {
				a: { id: "a", status: "completed", attempts: 1, maxRetries: 0 },
				b: { id: "b", status: "pending", attempts: 0, maxRetries: 0 },
			},
			completedBranches: { a: "aery/task/a" },
			status: "active",
			createdAt: 0,
			updatedAt: 0,
		};
		SwarmStore.open().save(swarm);

		const [loaded] = SwarmStore.open().listActive();
		expect(loaded).toBeDefined();
		expect(loaded.id).toBe("swarm-1");
		expect(loaded.status).toBe("active");
		expect(loaded.taskStates.a.status).toBe("completed");
		expect(loaded.completedBranches).toEqual({ a: "aery/task/a" });
	});

	it("fromPersisted restores task states and branch provenance", () => {
		const workflowData = workflow([
			{ id: "a", agent: "task", assignment: "A" },
			{ id: "b", agent: "task", assignment: "B", needs: ["a"] },
		]);
		const scheduler = SwarmScheduler.fromPersisted({
			id: "swarm-2",
			workflow: workflowData,
			taskStates: {
				a: { id: "a", status: "completed", attempts: 1, maxRetries: 0 },
				b: { id: "b", status: "pending", attempts: 0, maxRetries: 0 },
			},
			completedBranches: { a: "aery/task/a" },
		});

		expect(scheduler.swarmId).toBe("swarm-2");
		expect(scheduler.taskStates.get("a")?.status).toBe("completed");
		expect(scheduler.taskStates.get("b")?.status).toBe("pending");
	});
});

describe("SwarmScheduler persist + resume semantics", () => {
	beforeEach(() => {
		testDir = path.join("/tmp", `swarm-persist-test-${Math.random().toString(36).slice(2)}`);
		repoRoot = path.join(testDir, "repo");
		fs.mkdirSync(repoRoot, { recursive: true });
		setAgentDir(testDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("short-circuits already-completed nodes without touching git", async () => {
		// All nodes completed: resume must skip every one (no git branch work),
		// leave statuses untouched, and resolve cleanly.
		const workflowData = workflow([
			{ id: "a", agent: "task", assignment: "A" },
			{ id: "b", agent: "task", assignment: "B", needs: ["a"] },
		]);
		const scheduler = SwarmScheduler.fromPersisted({
			id: "swarm-3",
			workflow: workflowData,
			taskStates: {
				a: { id: "a", status: "completed", attempts: 1, maxRetries: 0 },
				b: { id: "b", status: "completed", attempts: 1, maxRetries: 0 },
			},
			completedBranches: { a: "aery/task/a", b: "aery/task/b" },
		});

		await scheduler.execute({
			sessionManager: { getCwd: () => repoRoot },
			session: { modelRegistry: {} },
			settings: {},
		});

		// If the short-circuit were missing, execute() would flip these to
		// "running"/"failed" (git worktree work would fail in a bare dir).
		expect(scheduler.taskStates.get("a")?.status).toBe("completed");
		expect(scheduler.taskStates.get("b")?.status).toBe("completed");
		// No worktrees should have been created.
		expect(fs.existsSync(path.join(repoRoot, ".aery", "worktrees"))).toBe(false);
	});

	it("persists a running-then-terminal transition as an active row in the store", async () => {
		// A single node in a bare dir triggers #persist() on the running
		// transition (and on completion or failure). Regardless of whether the
		// subprocess completes or fails in this env, the store must end up with
		// an "active" row carrying the terminal task state.
		const scheduler = new SwarmScheduler(
			workflow([{ id: "a", agent: "task", assignment: "A", maxRetries: 0 }]),
			"swarm-4",
		);

		try {
			await scheduler.execute({
				sessionManager: { getCwd: () => repoRoot },
				session: { modelRegistry: {} },
				settings: {},
			});
		} catch {
			// execute() may reject if the task fails; that's fine — the
			// persistence loop is what we're asserting.
		}

		const persisted = SwarmStore.open().get("swarm-4");
		expect(persisted).not.toBeNull();
		expect(persisted!.status).toBe("active");
		expect(["completed", "failed"]).toContain(persisted!.taskStates.a.status);
	});
});
