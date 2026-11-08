import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import { GitCheckpointService } from "@aryee337/aery-core/checkpoint";
import { prompt } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import checkpointDescription from "../prompts/tools/checkpoint.md" with { type: "text" };
import rewindDescription from "../prompts/tools/rewind.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
	/** Git commit SHA at checkpoint if in a git repository */
	commit?: string;
	/** Hidden git ref at checkpoint if in a git repository */
	ref?: string;
}

const checkpointSchema = z.object({
	goal: z.string().describe("investigation goal"),
});

type CheckpointParams = z.infer<typeof checkpointSchema>;

const rewindSchema = z.object({
	report: z.string().describe("investigation findings"),
});

type RewindParams = z.infer<typeof rewindSchema>;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	commit?: string;
	ref?: string;
	meta?: OutputMeta;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	commit?: string;
	ref?: string;
	meta?: OutputMeta;
}

function isTopLevelSession(session: ToolSession): boolean {
	const depth = session.taskDepth;
	return depth === undefined || depth === 0;
}

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly approval = "read" as const;
	readonly label = "Checkpoint";
	readonly summary = "Create a git-based checkpoint to save and restore session state";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<CheckpointParams>) => (args.goal ? `checkpointing: ${args.goal}` : "checkpointing");
	readonly gitCheckpointService: GitCheckpointService;

	constructor(
		private readonly session: ToolSession,
		gitCheckpointService?: GitCheckpointService,
	) {
		this.description = prompt.render(checkpointDescription);
		this.gitCheckpointService =
			gitCheckpointService ?? session.gitCheckpointService ?? new GitCheckpointService(session.cwd);
	}

	static createIf(session: ToolSession, gitCheckpointService?: GitCheckpointService): CheckpointTool | null {
		if (!isTopLevelSession(session)) return null;
		return new CheckpointTool(session, gitCheckpointService);
	}

	async execute(
		_toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (this.session.getCheckpointState?.()) {
			throw new ToolError("Checkpoint already active.");
		}
		const goal = params.goal.trim();
		if (goal.length === 0) {
			throw new ToolError("Goal cannot be empty.");
		}
		const startedAt = new Date().toISOString();
		const sessionId = this.session.getSessionId?.() ?? "default-session";
		const entryId =
			this.session.sessionManager?.getLeafId?.() ??
			this.session.sessionManager?.getLeafEntry?.()?.id ??
			this.session.sessionManager?.getEntries?.().at(-1)?.id ??
			`cp-${Date.now()}`;

		let commit: string | undefined;
		let ref: string | undefined;

		const isRepo = await this.gitCheckpointService.isGitRepository(this.session.cwd);
		if (isRepo) {
			const result = await this.gitCheckpointService.captureCheckpoint({
				cwd: this.session.cwd,
				sessionId,
				entryId,
				message: `Agent checkpoint: ${goal}`,
			});
			commit = result.commit;
			ref = result.ref;
		}

		const state: CheckpointState = {
			checkpointMessageCount: 0,
			checkpointEntryId: entryId,
			startedAt,
			commit,
			ref,
		};
		this.session.setCheckpointState?.(state);

		const lines = ["Checkpoint created.", `Goal: ${goal}`];
		if (ref && commit) {
			lines.push(`Ref: ${ref}`);
			lines.push(`Commit: ${commit}`);
		}
		lines.push("Run your investigation, then call rewind with a concise report.");

		return toolResult<CheckpointToolDetails>({
			goal,
			startedAt,
			commit,
			ref,
		})
			.text(lines.join("\n"))
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly approval = "read" as const;
	readonly label = "Rewind";
	readonly summary = "Rewind to a previously created checkpoint";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "rewinding";
	readonly gitCheckpointService: GitCheckpointService;

	constructor(
		private readonly session: ToolSession,
		gitCheckpointService?: GitCheckpointService,
	) {
		this.description = prompt.render(rewindDescription);
		this.gitCheckpointService =
			gitCheckpointService ?? session.gitCheckpointService ?? new GitCheckpointService(session.cwd);
	}

	static createIf(session: ToolSession, gitCheckpointService?: GitCheckpointService): RewindTool | null {
		if (!isTopLevelSession(session)) return null;
		return new RewindTool(session, gitCheckpointService);
	}

	async execute(
		_toolCallId: string,
		params: RewindParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		const checkpointState = this.session.getCheckpointState?.();
		if (!checkpointState) {
			throw new ToolError("No active checkpoint.");
		}
		const report = params.report.trim();
		if (report.length === 0) {
			throw new ToolError("Report cannot be empty.");
		}

		let rewoundCommit: string | undefined = checkpointState.commit;
		let rewoundRef: string | undefined = checkpointState.ref;

		const isRepo = await this.gitCheckpointService.isGitRepository(this.session.cwd);
		if (isRepo) {
			const sessionId = this.session.getSessionId?.() ?? "default-session";
			const entryId = checkpointState.checkpointEntryId ?? "checkpoint";
			await this.gitCheckpointService.restoreCheckpoint({
				cwd: this.session.cwd,
				sessionId,
				entryId,
			});
			rewoundRef = rewoundRef ?? `refs/aery/checkpoints/${sessionId}/${entryId}`;
			rewoundCommit =
				rewoundCommit ??
				(await this.gitCheckpointService.resolveCheckpointCommit({
					cwd: this.session.cwd,
					sessionId,
					entryId,
				})) ??
				undefined;
		}

		if (checkpointState.checkpointEntryId && this.session.sessionManager?.branch) {
			try {
				this.session.sessionManager.branch(checkpointState.checkpointEntryId);
			} catch {
				// Handled gracefully if session manager entry is missing
			}
		}

		const lines = ["Rewind completed."];
		if (rewoundRef) {
			lines.push(`Restored working tree to ${rewoundRef}${rewoundCommit ? ` (${rewoundCommit})` : ""}.`);
		}
		lines.push("Report captured for context replacement.");

		return toolResult<RewindToolDetails>({
			report,
			rewound: true,
			commit: rewoundCommit,
			ref: rewoundRef,
		})
			.text(lines.join("\n"))
			.done();
	}
}

export function createCheckpointTool(
	session: ToolSession,
	gitCheckpointService?: GitCheckpointService,
): CheckpointTool | null {
	return CheckpointTool.createIf(session, gitCheckpointService);
}

export function createRewindTool(session: ToolSession, gitCheckpointService?: GitCheckpointService): RewindTool | null {
	return RewindTool.createIf(session, gitCheckpointService);
}
