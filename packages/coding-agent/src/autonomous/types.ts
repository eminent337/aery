/**
 * Autonomous Mode Types
 *
 * Bounded autonomous execution with quality gates and continuation prompts.
 * Integrates with Ferment for structured workflow orchestration.
 */

/**
 * Budget constraints for autonomous execution.
 */
export interface AutonomousBudget {
	/** Maximum tokens allowed (input + output) */
	tokens?: number;
	/** Maximum wall-clock time in milliseconds */
	timeMs?: number;
	/** Maximum number of turns/iterations */
	turns?: number;
}

/**
 * Quality gate to validate output at each step.
 */
export interface QualityGate {
	/** Name/description of the gate */
	name: string;
	/** Shell command to execute */
	command: string;
	/** Maximum retries on failure */
	maxRetries?: number;
	/** Current retry count (internal) */
	retries?: number;
}

/**
 * State of an autonomous execution session.
 */
export interface AutonomousState {
	/** Unique identifier */
	id: string;
	/** The objective to accomplish */
	objective: string;
	/** Current status */
	status: AutonomousStatus;
	/** Budget constraints */
	budget: AutonomousBudget;
	/** Quality gates to enforce */
	gates: QualityGate[];
	/** Tokens used so far */
	tokensUsed: number;
	/** Time used in milliseconds */
	timeUsedMs: number;
	/** Turns/iterations completed */
	turnsUsed: number;
	/** Whether autonomy is enabled */
	enabled: boolean;
	/** Current continuation prompt (if any) */
	continuationPrompt?: string;
	/** Last gate failure message */
	lastGateFailure?: string;
	/** Creation timestamp */
	createdAt: number;
	/** Last update timestamp */
	updatedAt: number;
}

export type AutonomousStatus =
	| "idle" /** Not started */
	| "active" /** Running autonomously */
	| "gate-failed" /** Quality gate failed, awaiting retry */
	| "budget-exhausted" /** Token/time/turn budget exhausted */
	| "paused" /** Paused by user */
	| "complete" /** Objective achieved */
	| "aborted"; /** Manually aborted */

/**
 * Event emitted during autonomous execution.
 */
export type AutonomousEvent =
	| { type: "started"; state: AutonomousState }
	| { type: "turn_completed"; turnsUsed: number; tokensUsed: number }
	| { type: "gate_passed"; gateName: string }
	| { type: "gate_failed"; gateName: string; error: string; retries: number }
	| { type: "budget_check"; tokensUsed: number; timeUsedMs: number; turnsUsed: number }
	| { type: "paused" }
	| { type: "resumed" }
	| { type: "completed"; finalState: AutonomousState }
	| { type: "aborted"; reason?: string };

/**
 * Configuration for autonomous mode in Ferment.
 */
export interface AutonomousFermentConfig {
	/** Whether autonomous mode is enabled */
	enabled?: boolean;
	/** Budget constraints */
	budget?: AutonomousBudget;
	/** Quality gates */
	gates?: Omit<QualityGate, "retries">[];
	/** Custom continuation prompt */
	continuationPrompt?: string;
	/** Maximum continuations before forcing completion */
	maxContinuations?: number;
}

/**
 * Extended Ferment config with autonomous mode support.
 */
export interface AutonomousFermentExtension {
	/** Autonomous mode configuration */
	autonomous?: AutonomousFermentConfig;
}

/**
 * Host interface for autonomous runtime.
 * Provides access to session state and execution capabilities.
 */
export interface AutonomousRuntimeHost {
	/** Get current token usage */
	getCurrentUsage(): { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	/** Get current wall-clock time */
	now(): number;
	/** Execute a shell command */
	executeCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Emit an event */
	emit(event: AutonomousEvent): void;
	/** Get current state */
	getState(): AutonomousState | undefined;
	/** Update state */
	setState(state: AutonomousState): void;
	/** Persist state */
	persist(state: AutonomousState): Promise<void>;
	/** Send hidden message to user */
	sendHiddenMessage(message: string): Promise<void>;
}

/**
 * Result of autonomous execution.
 */
export interface AutonomousResult {
	/** Whether execution completed successfully */
	success: boolean;
	/** Final state */
	state: AutonomousState;
	/** Total tokens used */
	totalTokens: number;
	/** Total time in ms */
	totalTimeMs: number;
	/** Total turns */
	totalTurns: number;
	/** Any errors encountered */
	errors?: string[];
}
