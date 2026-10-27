import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { allocateBattleWorktree, cleanupBattleWorktree, getBattleDiff } from "../worktree-allocator";

const exec = promisify(execFile);

describe("Battle Worktree Allocator", () => {
	let testRepoDir: string;

	beforeAll(async () => {
		testRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-battle-test-repo-"));
		await exec("git", ["init", "-b", "main"], { cwd: testRepoDir });
		await exec("git", ["config", "user.email", "test@aery.ai"], { cwd: testRepoDir });
		await exec("git", ["config", "user.name", "Aery Test"], { cwd: testRepoDir });
		await fs.writeFile(path.join(testRepoDir, "README.md"), "# Initial Commit\n");
		await exec("git", ["add", "."], { cwd: testRepoDir });
		await exec("git", ["commit", "-m", "Initial commit"], { cwd: testRepoDir });
	});

	afterAll(async () => {
		try {
			await fs.rm(testRepoDir, { recursive: true, force: true });
		} catch {}
	});

	it("allocates, creates changes, inspects diff, and cleans up worktree", async () => {
		const battleId = `test-${Date.now()}`;
		const candidateId = "c1";

		const { worktreePath, branchName } = await allocateBattleWorktree(testRepoDir, battleId, candidateId);
		expect(worktreePath).toBeDefined();
		expect(branchName).toBe(`battle/${battleId}/${candidateId}`);

		// Check worktree exists on disk
		const stat = await fs.stat(worktreePath);
		expect(stat.isDirectory()).toBe(true);

		// Make a change in the candidate worktree
		await fs.writeFile(path.join(worktreePath, "feature.txt"), "New feature\n");
		await exec("git", ["add", "."], { cwd: worktreePath });
		await exec("git", ["commit", "-m", "Add feature"], { cwd: worktreePath });

		// Read diff against main
		const diff = await getBattleDiff(worktreePath, "main");
		expect(diff.totalAdditions).toBeGreaterThan(0);
		expect(diff.files.length).toBe(1);
		expect(diff.files[0].path).toBe("feature.txt");

		// Clean up
		await cleanupBattleWorktree(testRepoDir, worktreePath, branchName, true);

		// Verify worktree dir is removed
		let exists = true;
		try {
			await fs.stat(worktreePath);
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);
	});
});
