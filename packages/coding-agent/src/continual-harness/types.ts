/**
 * Continual Harness Types
 * 
 * Ported from Prime-Agent's refinement.ts to support persistent,
 * editable harness state for prompts, memories, skills, and subagents.
 */

/**
 * Type of artifact being refined.
 */
export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";

/**
 * Action to take on an artifact.
 */
export type RefinementAction = "create" | "update" | "delete";

/**
 * Scope of a harness entry.
 */
export type HarnessScope = "local" | "global";

/**
 * A single entry in the continual harness.
 */
export interface HarnessEntry {
	/** Unique identifier */
	id: string;
	/** Type of artifact */
	kind: RefinementKind;
	/** Human-readable title */
	title: string;
	/** Artifact content */
	content: string;
	/** Optional path for grouping */
	path: string;
	/** Scope: local (session) or global (cross-session) */
	scope?: HarnessScope;
	/** For skills: reference to callable */
	reference: Record<string, unknown>;
	/** For skills: accepted arguments */
	arguments: Record<string, unknown>;
	/** Additional metadata */
	metadata: Record<string, unknown>;
	/** Source of the entry */
	source: string;
	/** ISO timestamp */
	created_at: string;
	/** ISO timestamp */
	updated_at: string;
	/** Version number */
	version: number;
}

/**
 * Event tracking a refinement operation.
 */
export interface HarnessRefinementEvent {
	/** Unique ID */
	id: string;
	/** What triggered this */
	trigger: string;
	/** List of changes made */
	changes: string[];
	/** Evidence supporting the change */
	evidence: string;
	/** Outcome of the change */
	outcome: string;
	/** ISO timestamp */
	created_at: string;
}

/**
 * Persistent state of the continual harness.
 */
export interface HarnessState {
	/** Schema version */
	schema: number;
	/** Entries organized by kind */
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	/** History of refinement events */
	refinements: HarnessRefinementEvent[];
}

/**
 * A single edit proposal.
 */
export interface RefinementEdit {
	/** Action to take */
	action: RefinementAction;
	/** Type of artifact */
	kind: RefinementKind;
	/** ID for update/delete (optional for create) */
	id?: string;
	/** Title (required for create/update) */
	title?: string;
	/** Content (required for create/update) */
	content?: string;
	/** Optional path */
	path?: string;
	/** For skills: reference object */
	reference?: Record<string, unknown>;
	/** For skills: arguments object */
	arguments?: Record<string, unknown>;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
	/** Reason for the edit */
	reason?: string;
}

/**
 * A refinement proposal from the LLM.
 */
export interface RefinementProposal {
	/** Summary of changes */
	summary: string;
	/** Rationale */
	rationale: string;
	/** Proposed edits */
	edits: RefinementEdit[];
	/** Expected outcome */
	expectedOutcome: string;
}

/**
 * An applied edit with before/after state.
 */
export interface AppliedRefinementEdit extends RefinementEdit {
	/** Unique ID */
	id: string;
	/** State before edit */
	before?: HarnessEntry;
	/** State after edit */
	after?: HarnessEntry;
	/** Whether apply succeeded */
	applied: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Result of applying a refinement proposal.
 */
export interface RefinementResult {
	/** Unique ID */
	id: string;
	/** Summary */
	summary: string;
	/** Rationale */
	rationale: string;
	/** Expected outcome */
	expectedOutcome: string;
	/** Applied edits */
	appliedEdits: AppliedRefinementEdit[];
	/** Path to harness state file */
	harnessStatePath: string;
	/** ID of refinement being rolled back (if any) */
	rollbackOf?: string;
	/** Scope */
	scope?: HarnessScope;
}

/**
 * Options for refinement.
 */
export interface RefineOptions {
	/** Optional instructions to focus the refinement */
	instructions?: string;
	/** ID of refinement to rollback */
	rollbackId?: string;
	/** Whether to use global scope */
	global?: boolean;
}

/**
 * Reason for auto-refine trigger.
 */
export type AutoRefineReason = "turn_interval" | "compact";

/**
 * Context for auto-refine review.
 */
export interface AutoRefineReviewContext {
	/** Why this is triggering */
	reason: AutoRefineReason;
	/** Turns since last review */
	turnsSinceLastReview: number;
}

/**
 * Result of auto-refine review.
 */
export interface AutoRefineReview {
	/** Whether to proceed with refinement */
	shouldRefine: boolean;
	/** Rationale */
	rationale: string;
	/** Optional instructions */
	instructions?: string;
}

/**
 * Host interface for harness operations.
 */
export interface HarnessHost {
	/** Get current harness state */
	getHarnessState(): Promise<HarnessState>;
	/** Save harness state */
	saveHarnessState(state: HarnessState): Promise<void>;
	/** Get refinement history */
	getRefinementHistory(): Promise<RefinementResult[]>;
	/** Append to refinement history */
	appendRefinementHistory(result: RefinementResult): Promise<void>;
	/** Get session trajectory */
	getTrajectory(): Promise<string>;
	/** Current timestamp */
	now(): string;
	/** Current time in ms */
	nowMs(): number;
}
