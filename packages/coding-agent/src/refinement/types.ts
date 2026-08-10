/**
 * Refinement System Types
 *
 * Review trajectory and improve memories, prompts, and skills.
 */

/**
 * Scope of refinement.
 */
export type RefinementScope = "local" | "global";

/**
 * Type of artifact being refined.
 */
export type RefinementTarget = "memory" | "prompt" | "skill";

/**
 * Evidence for a refinement decision.
 */
export interface RefinementEvidence {
	/** Source of evidence */
	source: string;
	/** Evidence content */
	content: string;
	/** Timestamp */
	timestamp: number;
}

/**
 * Refinement decision.
 */
export interface RefinementDecision {
	/** Unique ID */
	id: string;
	/** Target type */
	target: RefinementTarget;
	/** Target ID (for existing artifacts) */
	targetId?: string;
	/** Scope */
	scope: RefinementScope;
	/** Action to take */
	action: "create" | "update" | "delete" | "keep";
	/** Reasoning */
	reasoning: string;
	/** Evidence supporting the decision */
	evidence: RefinementEvidence[];
	/** Creation timestamp */
	createdAt: number;
}

/**
 * Trajectory review result.
 */
export interface TrajectoryReview {
	/** Summary of trajectory */
	summary: string;
	/** Decisions made */
	decisions: RefinementDecision[];
	/** Suggestions for improvement */
	suggestions: string[];
}

/**
 * Refinement host interface.
 */
export interface RefinementHost {
	/** Get trajectory/memories */
	getTrajectory(): Promise<string>;
	/** Get existing memories */
	getMemories(): Promise<Array<{ id: string; content: string; scope: RefinementScope }>>;
	/** Get existing prompts */
	getPrompts(): Promise<Array<{ id: string; content: string; scope: RefinementScope }>>;
	/** Get existing skills */
	getSkills(): Promise<Array<{ id: string; content: string; scope: RefinementScope }>>;
	/** Create a new artifact */
	createArtifact(target: RefinementTarget, content: string, scope: RefinementScope): Promise<string>;
	/** Update an existing artifact */
	updateArtifact(target: RefinementTarget, id: string, content: string): Promise<boolean>;
	/** Delete an artifact */
	deleteArtifact(target: RefinementTarget, id: string): Promise<boolean>;
	/** Get current time */
	now(): number;
}
