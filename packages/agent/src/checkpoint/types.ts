/**
 * Git Checkpoint types and options.
 */

export interface GitCheckpointOptions {
	cwd: string;
	sessionId: string;
	entryId: string;
}

export interface CaptureCheckpointOptions extends GitCheckpointOptions {
	message?: string;
}

export interface CheckpointResult {
	ref: string;
	commit: string;
	tree: string;
}

export interface CheckpointInfo {
	ref: string;
	sessionId: string;
	entryId: string;
	commit: string;
	timestamp: number;
}

export interface PruneCheckpointsOptions {
	cwd: string;
	maxAgeDays: number;
}

export interface PruneCheckpointsResult {
	deletedRefs: string[];
	deletedCount: number;
}

export type CheckpointPruneResult = PruneCheckpointsResult;

export interface ListCheckpointsOptions {
	cwd: string;
	sessionId?: string;
}
