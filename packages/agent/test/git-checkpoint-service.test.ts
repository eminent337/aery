import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	captureCheckpoint,
	GitCheckpointService,
	hasCheckpoint,
	isGitRepository,
	pruneCheckpoints,
	resolveCheckpointCommit,
	restoreCheckpoint,
} from "../src/checkpoint";

const execAsync = promisify(execFile);

describe("GitCheckpointService", () => {
	const tempDirs: string[] = [];

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function initGitRepo(): Promise<string> {
		const dir = await createTempDir("aery-test-repo-");
		await execAsync("git", ["init"], { cwd: dir });
		await execAsync("git", ["config", "user.name", "Aery Test"], { cwd: dir });
		await execAsync("git", ["config", "user.email", "test@aery.local"], { cwd: dir });

		// Baseline commit
		await fs.writeFile(path.join(dir, "baseline.txt"), "baseline content", "utf8");
		await execAsync("git", ["add", "baseline.txt"], { cwd: dir });
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

	it("verifies isGitRepository returns true for a git repo and false for a non-git dir", async () => {
		const repoDir = await initGitRepo();
		const nonRepoDir = await createTempDir("aery-non-repo-");
		const nonexistentDir = path.join(os.tmpdir(), `nonexistent-dir-${Math.random().toString(36).slice(2)}`);

		expect(await isGitRepository(repoDir)).toBe(true);
		expect(await isGitRepository(nonRepoDir)).toBe(false);
		expect(await isGitRepository(nonexistentDir)).toBe(false);

		// Also verify via class instance and static method
		const service = new GitCheckpointService(repoDir);
		expect(await service.isGitRepository()).toBe(true);
		expect(await GitCheckpointService.isGitRepository(repoDir)).toBe(true);
	});

	it("creates a hidden ref using an isolated temporary GIT_INDEX_FILE and does not alter HEAD", async () => {
		const repoDir = await initGitRepo();
		const sessionId = "sess-100";
		const entryId = "entry-200";

		// Record HEAD commit and count before checkpoint
		const { stdout: headBefore } = await execAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
		const { stdout: countBefore } = await execAsync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir });

		// Add modified file and untracked file
		await fs.writeFile(path.join(repoDir, "baseline.txt"), "modified baseline content", "utf8");
		await fs.writeFile(path.join(repoDir, "untracked.txt"), "new untracked file", "utf8");

		// Staging status in real repo index should remain clean/empty before and after
		const { stdout: diffCachedBefore } = await execAsync("git", ["diff", "--cached"], { cwd: repoDir });
		expect(diffCachedBefore.trim()).toBe("");

		// Capture checkpoint
		const result = await captureCheckpoint({
			cwd: repoDir,
			sessionId,
			entryId,
		});

		expect(result).toBeDefined();
		expect(result.ref).toBe(`refs/aery/checkpoints/${sessionId}/${entryId}`);
		expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

		// Verify ref exists in git
		const { stdout: refCommit } = await execAsync("git", ["rev-parse", result.ref], { cwd: repoDir });
		expect(refCommit.trim()).toBe(result.commit);

		// Verify HEAD was NOT modified
		const { stdout: headAfter } = await execAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
		const { stdout: countAfter } = await execAsync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir });
		expect(headAfter.trim()).toBe(headBefore.trim());
		expect(countAfter.trim()).toBe(countBefore.trim());

		// Verify real repo index was not touched
		const { stdout: diffCachedAfter } = await execAsync("git", ["diff", "--cached"], { cwd: repoDir });
		expect(diffCachedAfter.trim()).toBe("");
	});

	it("correctly checks hasCheckpoint and resolveCheckpointCommit", async () => {
		const repoDir = await initGitRepo();
		const sessionId = "sess-abc";
		const entryId = "entry-xyz";

		// Before capture
		expect(await hasCheckpoint({ cwd: repoDir, sessionId, entryId })).toBe(false);
		expect(await resolveCheckpointCommit({ cwd: repoDir, sessionId, entryId })).toBeNull();

		// Capture
		const res = await captureCheckpoint({ cwd: repoDir, sessionId, entryId });

		// After capture
		expect(await hasCheckpoint({ cwd: repoDir, sessionId, entryId })).toBe(true);
		const commitSha = await resolveCheckpointCommit({ cwd: repoDir, sessionId, entryId });
		expect(commitSha).toBe(res.commit);
	});

	it("restores modified files and cleans untracked files", async () => {
		const repoDir = await initGitRepo();
		const sessionId = "sess-restore";
		const entryId = "entry-1";

		// Set up checkpoint state
		await fs.writeFile(path.join(repoDir, "fileA.txt"), "content A original", "utf8");
		await fs.writeFile(path.join(repoDir, "fileB.txt"), "content B original", "utf8");

		const checkpoint = await captureCheckpoint({
			cwd: repoDir,
			sessionId,
			entryId,
		});
		expect(checkpoint.commit).toBeDefined();

		// Mutate working tree:
		// 1. Modify fileA.txt
		await fs.writeFile(path.join(repoDir, "fileA.txt"), "content A modified", "utf8");
		// 2. Delete fileB.txt
		await fs.unlink(path.join(repoDir, "fileB.txt"));
		// 3. Add untracked fileC.txt
		await fs.writeFile(path.join(repoDir, "fileC.txt"), "untracked file", "utf8");
		// 4. Add untracked directory and file
		await fs.mkdir(path.join(repoDir, "subdir"));
		await fs.writeFile(path.join(repoDir, "subdir", "nested.txt"), "nested untracked", "utf8");

		// Verify mutations took effect
		expect(await fs.readFile(path.join(repoDir, "fileA.txt"), "utf8")).toBe("content A modified");
		let fileBExists = true;
		try {
			await fs.access(path.join(repoDir, "fileB.txt"));
		} catch {
			fileBExists = false;
		}
		expect(fileBExists).toBe(false);
		expect(await fs.readFile(path.join(repoDir, "fileC.txt"), "utf8")).toBe("untracked file");

		// Restore checkpoint
		await restoreCheckpoint({
			cwd: repoDir,
			sessionId,
			entryId,
		});

		// Verify restoration:
		// 1. fileA.txt restored
		expect(await fs.readFile(path.join(repoDir, "fileA.txt"), "utf8")).toBe("content A original");
		// 2. fileB.txt restored
		expect(await fs.readFile(path.join(repoDir, "fileB.txt"), "utf8")).toBe("content B original");
		// 3. fileC.txt removed
		let fileCExists = true;
		try {
			await fs.access(path.join(repoDir, "fileC.txt"));
		} catch {
			fileCExists = false;
		}
		expect(fileCExists).toBe(false);
		// 4. subdir removed
		let subdirExists = true;
		try {
			await fs.access(path.join(repoDir, "subdir"));
		} catch {
			subdirExists = false;
		}
		expect(subdirExists).toBe(false);
	});

	it("pruneCheckpoints deletes refs older than the threshold", async () => {
		const repoDir = await initGitRepo();
		const sessionId = "sess-prune";
		const oldEntryId = "entry-old";
		const freshEntryId = "entry-fresh";

		// Create old checkpoint using older committer date (14 days ago)
		const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
		const oldEnv = {
			...process.env,
			GIT_AUTHOR_DATE: oldDate,
			GIT_COMMITTER_DATE: oldDate,
			GIT_INDEX_FILE: path.join(os.tmpdir(), `old-idx-${Math.random().toString(36).slice(2)}`),
		};

		// Helper to write tree and commit with custom env
		await execAsync("git", ["read-tree", "HEAD"], { cwd: repoDir, env: oldEnv });
		const { stdout: oldTree } = await execAsync("git", ["write-tree"], { cwd: repoDir, env: oldEnv });
		const { stdout: oldCommit } = await execAsync(
			"git",
			["commit-tree", oldTree.trim(), "-p", "HEAD", "-m", "old checkpoint"],
			{ cwd: repoDir, env: oldEnv },
		);
		await execAsync("git", ["update-ref", `refs/aery/checkpoints/${sessionId}/${oldEntryId}`, oldCommit.trim()], {
			cwd: repoDir,
		});
		try {
			await fs.rm(oldEnv.GIT_INDEX_FILE, { force: true });
		} catch {
			// ignore
		}

		// Create fresh checkpoint (now)
		await captureCheckpoint({
			cwd: repoDir,
			sessionId,
			entryId: freshEntryId,
		});

		expect(await hasCheckpoint({ cwd: repoDir, sessionId, entryId: oldEntryId })).toBe(true);
		expect(await hasCheckpoint({ cwd: repoDir, sessionId, entryId: freshEntryId })).toBe(true);

		// Prune checkpoints older than 7 days
		const pruneResult = await pruneCheckpoints({ cwd: repoDir, maxAgeDays: 7 });

		expect(pruneResult.deletedCount).toBeGreaterThanOrEqual(1);
		expect(pruneResult.deletedRefs).toContain(`refs/aery/checkpoints/${sessionId}/${oldEntryId}`);

		// Old checkpoint should be deleted, fresh checkpoint should remain
		expect(await hasCheckpoint({ cwd: repoDir, sessionId, entryId: oldEntryId })).toBe(false);
		expect(await hasCheckpoint({ cwd: repoDir, sessionId, entryId: freshEntryId })).toBe(true);
	});
});
