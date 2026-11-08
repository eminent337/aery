import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { GitCheckpointService } from "@aryee337/aery-core/checkpoint";
import { SessionCheckpointCoordinator } from "../src/checkpoint";

const execAsync = promisify(execFile);

describe("SessionCheckpointCoordinator", () => {
	const tempDirs: string[] = [];

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function initGitRepo(): Promise<string> {
		const dir = await createTempDir("aery-coord-test-repo-");
		await execAsync("git", ["init"], { cwd: dir });
		await execAsync("git", ["config", "user.name", "Aery Test"], { cwd: dir });
		await execAsync("git", ["config", "user.email", "test@aery.local"], { cwd: dir });

		// Baseline commit
		await fs.writeFile(path.join(dir, "app.ts"), 'console.log("v1 baseline");\n', "utf8");
		await execAsync("git", ["add", "app.ts"], { cwd: dir });
		await execAsync("git", ["commit", "-m", "initial baseline commit"], { cwd: dir });

		return dir;
	}

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it("verifies onTurnStart creates checkpoint and records entry ID", async () => {
		const repoDir = await initGitRepo();
		const coordinator = new SessionCheckpointCoordinator({
			cwd: repoDir,
			sessionId: "session-alpha",
		});

		expect(coordinator.getCapturedCount()).toBe(0);
		expect(coordinator.hasCaptured("entry-1")).toBe(false);

		const result = await coordinator.onTurnStart("entry-1");
		expect(result).not.toBeNull();
		expect(result?.ref).toBe("refs/aery/checkpoints/session-alpha/entry-1");
		expect(result?.commit).toBeDefined();
		expect(result?.tree).toBeDefined();

		expect(coordinator.hasCaptured("entry-1")).toBe(true);
		expect(coordinator.getCapturedCount()).toBe(1);
	});

	it("verifies duplicate onTurnStart for same entryId is a no-op (deduplicated)", async () => {
		const repoDir = await initGitRepo();
		const coordinator = new SessionCheckpointCoordinator({
			cwd: repoDir,
			sessionId: "session-alpha",
		});

		const firstResult = await coordinator.onTurnStart("entry-dup");
		expect(firstResult).not.toBeNull();
		expect(coordinator.getCapturedCount()).toBe(1);

		// Modify a file to verify subsequent duplicate turn does not recapture
		await fs.writeFile(path.join(repoDir, "app.ts"), 'console.log("v2 modified");\n', "utf8");

		const secondResult = await coordinator.onTurnStart("entry-dup");
		expect(secondResult).toBeNull();
		expect(coordinator.getCapturedCount()).toBe(1);
		expect(coordinator.hasCaptured("entry-dup")).toBe(true);
	});

	it("verifies non-git directory returns null and does not throw", async () => {
		const nonRepoDir = await createTempDir("aery-coord-non-git-");
		const coordinator = new SessionCheckpointCoordinator({
			cwd: nonRepoDir,
			sessionId: "session-beta",
		});

		let result: unknown;
		let threw = false;

		try {
			result = await coordinator.onTurnStart("entry-non-git");
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
		expect(result).toBeNull();
		expect(coordinator.hasCaptured("entry-non-git")).toBe(false);
		expect(coordinator.getCapturedCount()).toBe(0);
	});

	it("verifies rewindTo modifies file on disk, restores file to baseline, and calls sessionManager.branch", async () => {
		const repoDir = await initGitRepo();
		const appPath = path.join(repoDir, "app.ts");
		const untrackedPath = path.join(repoDir, "temp-scratch.txt");

		let branchedId: string | null = null;
		const mockSessionManager = {
			getLeafEntry: () => ({ id: "leaf-99" }),
			branch: (branchFromId: string) => {
				branchedId = branchFromId;
			},
		};

		const coordinator = new SessionCheckpointCoordinator({
			cwd: repoDir,
			sessionId: "session-gamma",
			sessionManager: mockSessionManager,
		});

		// Capture baseline checkpoint
		const captureResult = await coordinator.onTurnStart("entry-checkpoint-1");
		expect(captureResult).not.toBeNull();

		// Simulate agent edits and untracked file creations
		await fs.writeFile(appPath, 'console.log("mutated by tool execution");\n', "utf8");
		await fs.writeFile(untrackedPath, "untracked artifact", "utf8");

		expect(await fs.readFile(appPath, "utf8")).toBe('console.log("mutated by tool execution");\n');
		expect(await fs.readFile(untrackedPath, "utf8")).toBe("untracked artifact");

		// Rewind to checkpoint
		const success = await coordinator.rewindTo("entry-checkpoint-1");
		expect(success).toBe(true);

		// Verify file restored to baseline
		expect(await fs.readFile(appPath, "utf8")).toBe('console.log("v1 baseline");\n');

		// Verify untracked file cleaned
		let untrackedExists = true;
		try {
			await fs.access(untrackedPath);
		} catch {
			untrackedExists = false;
		}
		expect(untrackedExists).toBe(false);

		// Verify sessionManager.branch was called with entryId
		expect(branchedId).toBe("entry-checkpoint-1");
	});

	it("verifies rewindTo without sessionManager restores code cleanly", async () => {
		const repoDir = await initGitRepo();
		const appPath = path.join(repoDir, "app.ts");

		const coordinator = new SessionCheckpointCoordinator({
			cwd: repoDir,
			sessionId: "session-no-sm",
		});

		await coordinator.onTurnStart("entry-clean");
		await fs.writeFile(appPath, 'console.log("dirty edit");\n', "utf8");

		const success = await coordinator.rewindTo("entry-clean");
		expect(success).toBe(true);
		expect(await fs.readFile(appPath, "utf8")).toBe('console.log("v1 baseline");\n');
	});

	it("verifies rewindTo returns false when checkpoint does not exist", async () => {
		const repoDir = await initGitRepo();
		const coordinator = new SessionCheckpointCoordinator({
			cwd: repoDir,
			sessionId: "session-missing",
		});

		const success = await coordinator.rewindTo("nonexistent-entry");
		expect(success).toBe(false);
	});

	it("verifies prune delegates cleanly to gitService with default and custom maxAgeDays", async () => {
		const repoDir = await initGitRepo();
		let pruneOptionsPassed: { cwd: string; maxAgeDays: number } | null = null;

		const mockGitService = {
			isGitRepository: async () => true,
			captureCheckpoint: async () => ({ ref: "r", commit: "c", tree: "t" }),
			restoreCheckpoint: async () => {},
			pruneCheckpoints: async (opts: { cwd: string; maxAgeDays: number }) => {
				pruneOptionsPassed = opts;
				return { deletedRefs: ["refs/aery/checkpoints/old"], deletedCount: 1 };
			},
		} as unknown as GitCheckpointService;

		const coordinator = new SessionCheckpointCoordinator({
			cwd: repoDir,
			sessionId: "session-prune",
			gitService: mockGitService,
		});

		// Prune with default maxAgeDays (should be 7)
		const res1 = await coordinator.prune();
		expect(res1.deletedCount).toBe(1);
		expect(res1.deletedRefs).toEqual(["refs/aery/checkpoints/old"]);
		expect(pruneOptionsPassed).toEqual({ cwd: repoDir, maxAgeDays: 7 });

		// Prune with explicit maxAgeDays (e.g. 14)
		const res2 = await coordinator.prune(14);
		expect(res2.deletedCount).toBe(1);
		expect(pruneOptionsPassed).toEqual({ cwd: repoDir, maxAgeDays: 14 });
	});
});
