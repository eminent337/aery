import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceMode } from "../types";

export interface WorktreeInfo {
	workspacePath: string;
	branchName?: string;
	mode: WorkspaceMode;
}

export class WorktreeManager {
	private readonly rootRepoDir: string;
	private readonly swarmId: string;
	private readonly worktreeBaseDir: string;
	private activeWorktrees = new Map<string, WorktreeInfo>();

	constructor(rootRepoDir: string, swarmId: string) {
		this.rootRepoDir = rootRepoDir;
		this.swarmId = swarmId;
		this.worktreeBaseDir = join(rootRepoDir, ".aery", "worktrees", swarmId);
	}

	public createWorktree(memberName: string, mode: WorkspaceMode): WorktreeInfo {
		if (mode === "inherit") {
			const info: WorktreeInfo = {
				workspacePath: this.rootRepoDir,
				mode: "inherit",
			};
			this.activeWorktrees.set(memberName, info);
			return info;
		}

		if (!existsSync(this.worktreeBaseDir)) {
			mkdirSync(this.worktreeBaseDir, { recursive: true });
		}

		const targetDir = join(this.worktreeBaseDir, memberName);
		const branchName = `swarm/${this.swarmId}/${memberName}`;

		if (mode === "share") {
			try {
				execSync(`git worktree add -B "${branchName}" "${targetDir}" HEAD`, {
					cwd: this.rootRepoDir,
					stdio: "ignore",
				});
			} catch {
				mkdirSync(targetDir, { recursive: true });
			}
		} else if (mode === "branch") {
			try {
				execSync(`git clone --shared . "${targetDir}"`, {
					cwd: this.rootRepoDir,
					stdio: "ignore",
				});
			} catch {
				mkdirSync(targetDir, { recursive: true });
			}
		}

		const info: WorktreeInfo = {
			workspacePath: targetDir,
			branchName,
			mode,
		};
		this.activeWorktrees.set(memberName, info);
		return info;
	}

	public removeWorktree(memberName: string): void {
		const info = this.activeWorktrees.get(memberName);
		if (!info) return;

		if (info.mode === "share") {
			try {
				execSync(`git worktree remove --force "${info.workspacePath}"`, {
					cwd: this.rootRepoDir,
					stdio: "ignore",
				});
			} catch {
				rmSync(info.workspacePath, { recursive: true, force: true });
			}
		} else if (info.mode === "branch") {
			rmSync(info.workspacePath, { recursive: true, force: true });
		}

		this.activeWorktrees.delete(memberName);
	}

	public cleanupAll(): void {
		for (const name of Array.from(this.activeWorktrees.keys())) {
			this.removeWorktree(name);
		}
		if (existsSync(this.worktreeBaseDir)) {
			rmSync(this.worktreeBaseDir, { recursive: true, force: true });
		}
	}
}
