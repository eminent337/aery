import {
	type CheckpointResult,
	GitCheckpointService,
	type PruneCheckpointsResult,
} from "@aryee337/aery-core/checkpoint";

export interface SessionCheckpointCoordinatorOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionManager?: {
		getLeafEntry(): { id: string } | undefined;
		branch(branchFromId: string): void;
	};
	readonly gitService?: GitCheckpointService;
}

export class SessionCheckpointCoordinator {
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionManager?: {
		getLeafEntry(): { id: string } | undefined;
		branch(branchFromId: string): void;
	};
	readonly gitService: GitCheckpointService;
	private readonly capturedEntryIds = new Set<string>();

	constructor(options: SessionCheckpointCoordinatorOptions) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;
		this.sessionManager = options.sessionManager;
		this.gitService = options.gitService ?? new GitCheckpointService(options.cwd);
	}

	/**
	 * Automatically captures a checkpoint before tool executions.
	 * Avoids duplicate capture if entryId has already been captured in this coordinator instance.
	 * Gracefully returns null if cwd is not a git repository.
	 * Records entry ID in internal tracking set.
	 */
	async onTurnStart(entryId: string): Promise<CheckpointResult | null> {
		if (this.hasCaptured(entryId)) {
			return null;
		}

		const isRepo = await this.gitService.isGitRepository(this.cwd);
		if (!isRepo) {
			return null;
		}

		try {
			const result = await this.gitService.captureCheckpoint({
				cwd: this.cwd,
				sessionId: this.sessionId,
				entryId,
			});
			this.capturedEntryIds.add(entryId);
			return result;
		} catch (error) {
			if (error instanceof Error && error.message.includes("Not a git repository")) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Checks whether a checkpoint has already been captured for the entry ID.
	 */
	hasCaptured(entryId: string): boolean {
		return this.capturedEntryIds.has(entryId);
	}

	/**
	 * Returns the number of captured checkpoints.
	 */
	getCapturedCount(): number {
		return this.capturedEntryIds.size;
	}

	/**
	 * Restores code to the specified checkpoint ref and branches the sessionManager if present.
	 * Returns boolean indicating success.
	 */
	async rewindTo(entryId: string): Promise<boolean> {
		try {
			await this.gitService.restoreCheckpoint({
				cwd: this.cwd,
				sessionId: this.sessionId,
				entryId,
			});
			if (this.sessionManager) {
				this.sessionManager.branch(entryId);
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Prunes checkpoints older than maxAgeDays (default 7).
	 */
	async prune(maxAgeDays?: number): Promise<PruneCheckpointsResult> {
		return this.gitService.pruneCheckpoints({
			cwd: this.cwd,
			maxAgeDays: maxAgeDays ?? 7,
		});
	}
}
