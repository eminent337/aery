import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../src/workspace/worktree-manager";

describe("WorktreeManager", () => {
	let gitRepoDir: string;
	let manager: WorktreeManager;

	beforeEach(() => {
		gitRepoDir = mkdtempSync(join(tmpdir(), "swarm-repo-"));
		execSync("git init -b main", { cwd: gitRepoDir, stdio: "ignore" });
		execSync("git config user.email 'test@test.com'", { cwd: gitRepoDir, stdio: "ignore" });
		execSync("git config user.name 'Test'", { cwd: gitRepoDir, stdio: "ignore" });
		execSync("echo 'initial' > README.md && git add . && git commit -m 'initial'", {
			cwd: gitRepoDir,
			stdio: "ignore",
		});
		manager = new WorktreeManager(gitRepoDir, "swarm-test-session");
	});

	afterEach(() => {
		manager.cleanupAll();
		rmSync(gitRepoDir, { recursive: true, force: true });
	});

	it("creates and removes git worktree for a member", () => {
		const info = manager.createWorktree("coder-1", "share");
		expect(existsSync(info.workspacePath)).toBe(true);
		expect(info.branchName).toBe("swarm/swarm-test-session/coder-1");

		manager.removeWorktree("coder-1");
		expect(existsSync(info.workspacePath)).toBe(false);
	});

	it("handles inherit mode with coordinator path", () => {
		const info = manager.createWorktree("reader-1", "inherit");
		expect(info.workspacePath).toBe(gitRepoDir);
	});

	it("creates and removes shared clone for branch mode", () => {
		const info = manager.createWorktree("branch-1", "branch");
		expect(existsSync(info.workspacePath)).toBe(true);
		expect(info.mode).toBe("branch");

		manager.removeWorktree("branch-1");
		expect(existsSync(info.workspacePath)).toBe(false);
	});

	it("cleans up all active worktrees", () => {
		const info1 = manager.createWorktree("share-w", "share");
		const info2 = manager.createWorktree("branch-w", "branch");
		expect(existsSync(info1.workspacePath)).toBe(true);
		expect(existsSync(info2.workspacePath)).toBe(true);

		manager.cleanupAll();
		expect(existsSync(info1.workspacePath)).toBe(false);
		expect(existsSync(info2.workspacePath)).toBe(false);
	});
});
