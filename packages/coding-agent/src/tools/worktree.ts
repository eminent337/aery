import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { getWorktreesDir } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const enterWorktreeSchema = z.object({
	name: z.string().optional().describe("Name for the isolated worktree or branch (defaults to aery-wt-<id>)"),
	branch: z.string().optional().describe("Base ref or branch to branch off of (defaults to HEAD)"),
});

export interface EnterWorktreeDetails {
	isolatedPath: string;
	parentRepo: string;
	worktreeName: string;
}

export class EnterWorktreeTool implements AgentTool<typeof enterWorktreeSchema, EnterWorktreeDetails> {
	readonly loadMode = "discoverable";
	readonly name = "enter_worktree";
	readonly approval = "execute";
	readonly label = "Enter Worktree";
	readonly description =
		"Creates and switches into an isolated git worktree before making modifications to protect the user's primary working tree.";
	readonly summary = "Create and switch into an isolated git worktree";
	readonly parameters = enterWorktreeSchema;

	constructor(private session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof enterWorktreeSchema>,
	): Promise<AgentToolResult<EnterWorktreeDetails>> {
		const cwd = process.cwd();
		let repo: git.GitRepository | null = null;
		try {
			repo = await git.resolveRepository(cwd);
		} catch {}

		if (!repo) {
			throw new ToolError("Worktree isolation requires an active git repository.");
		}

		// Check if already inside an agent worktree
		const wtDir = getWorktreesDir();
		if (cwd.startsWith(wtDir) || cwd.includes("/.aery/worktrees/")) {
			return {
				content: [
					{
						type: "text",
						text: `Already running in an isolated worktree at: ${cwd}`,
					},
				],
				details: {
					isolatedPath: cwd,
					parentRepo: repo.repoRoot,
					worktreeName: path.basename(cwd),
				},
			};
		}

		const suffix = Math.random().toString(36).substring(2, 8);
		const rawName = params.name
			? params.name.trim().replace(/[^a-zA-Z0-9_-]/g, "-")
			: `aery-wt-${Date.now()}-${suffix}`;
		const worktreeName = rawName || `aery-wt-${suffix}`;

		const targetPath = path.join(wtDir, `${path.basename(repo.repoRoot)}-${worktreeName}`);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });

		const ref = params.branch || "HEAD";

		try {
			await git.worktree.add(repo.repoRoot, targetPath, ref, { detach: true });
		} catch (err) {
			throw new ToolError(
				`Failed to create git worktree at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Switch current process cwd and update session if available
		process.chdir(targetPath);
		if ((this.session as unknown as { cwd?: string }).cwd !== undefined) {
			(this.session as unknown as { cwd: string }).cwd = targetPath;
		}

		const message = `Successfully entered isolated git worktree.\nIsolated working directory: ${targetPath}\nParent repository: ${repo.repoRoot}\nAll edits and commands will execute in isolation from the main workspace.`;

		return {
			content: [{ type: "text", text: message }],
			details: {
				isolatedPath: targetPath,
				parentRepo: repo.repoRoot,
				worktreeName,
			},
		};
	}
}

const exitWorktreeSchema = z.object({
	cleanup: z
		.boolean()
		.optional()
		.describe("Whether to delete the worktree and remove it from git tracking (default: false)"),
});

export interface ExitWorktreeDetails {
	originalRepo: string;
	previousWorktree: string;
	cleanedUp: boolean;
}

export class ExitWorktreeTool implements AgentTool<typeof exitWorktreeSchema, ExitWorktreeDetails> {
	readonly loadMode = "discoverable";
	readonly name = "exit_worktree";
	readonly approval = "execute";
	readonly label = "Exit Worktree";
	readonly description =
		"Exits the current isolated worktree and returns the working directory to the primary repository root.";
	readonly summary = "Exit isolated git worktree";
	readonly parameters = exitWorktreeSchema;

	constructor(private session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof exitWorktreeSchema>,
	): Promise<AgentToolResult<ExitWorktreeDetails>> {
		const currentPath = process.cwd();
		let repo: git.GitRepository | null = null;
		try {
			repo = await git.resolveRepository(currentPath);
		} catch {}

		if (!repo) {
			throw new ToolError("Not in a valid git repository.");
		}

		const parentRepo = repo.commonDir ? path.resolve(repo.commonDir, "..") : repo.repoRoot;

		if (parentRepo === currentPath) {
			return {
				content: [
					{
						type: "text",
						text: `Currently at primary repository root (${currentPath}). No worktree to exit.`,
					},
				],
				details: {
					originalRepo: parentRepo,
					previousWorktree: currentPath,
					cleanedUp: false,
				},
			};
		}

		// Change directory back to parent
		process.chdir(parentRepo);
		if ((this.session as unknown as { cwd?: string }).cwd !== undefined) {
			(this.session as unknown as { cwd: string }).cwd = parentRepo;
		}

		let cleanedUp = false;
		if (params.cleanup) {
			try {
				await git.worktree.remove(parentRepo, currentPath, { force: true });
				cleanedUp = true;
			} catch {
				try {
					await fs.rm(currentPath, { recursive: true, force: true });
					await git.worktree.prune(parentRepo);
					cleanedUp = true;
				} catch {
					cleanedUp = false;
				}
			}
		}

		const cleanupMsg = cleanedUp ? " (worktree deleted and cleaned up)" : " (worktree preserved on disk)";
		const message = `Exited worktree${cleanupMsg}.\nRestored working directory: ${parentRepo}`;

		return {
			content: [{ type: "text", text: message }],
			details: {
				originalRepo: parentRepo,
				previousWorktree: currentPath,
				cleanedUp,
			},
		};
	}
}
