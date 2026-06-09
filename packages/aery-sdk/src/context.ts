// ─── Session & File Context Types ────────────────────────────────────────────

/** Runtime context for the current Aery session */
export interface AerySessionContext {
	/** Unique identifier for this session */
	sessionId: string;
	/** Absolute path to the session's working directory */
	workingDirectory: string;
	/** Model identifier in use (e.g. "claude-opus-4-5") */
	model: string;
	/** Unix epoch millisecond when the session started */
	startedAt: number;
	/** Number of complete agent turns so far in this session */
	turnCount: number;
	/** Total token budget for this session, if set */
	tokensBudget?: number;
	/** Tokens consumed so far in this session */
	tokensUsed?: number;
}

/** A single file entry provided in the agent's context window */
export interface AeryFileContext {
	/** Absolute path to the file */
	path: string;
	/** Full text content of the file */
	content: string;
	/** Language identifier (e.g. "typescript", "python") */
	language: string;
	/** Unix epoch millisecond of last modification */
	lastModified: number;
}
