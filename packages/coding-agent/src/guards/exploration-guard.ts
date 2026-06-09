/**
 * Exploration guard — prevents excessive read-only turns.
 *
 * Tracks consecutive turns where
 * only read-only tools are used. At hypothesisThreshold (default 5), injects
 * a reminder. At steerThreshold (default 8), injects a mandatory steer and
 * resets the streak.
 *
 * A turn is "read-only" if it contains at least one read tool and no write
 * tools. Turns with no tools, only neutral tools, or any write tool reset the
 * streak.
 */

export interface ExplorationGuardOptions {
	/** Tools that count as read-only. Defaults to a built-in set. */
	readTools?: Set<string>;
	/** Tools that count as write operations. Defaults to a built-in set. */
	writeTools?: Set<string>;
	/** Number of consecutive read-only turns before a reminder is injected. Default: 5. */
	hypothesisThreshold?: number;
	/** Number of consecutive read-only turns before a mandatory steer. Default: 8. */
	steerThreshold?: number;
	/** Optional predicate to temporarily disable the guard. */
	isEnabled?: () => boolean;
}

export const DEFAULT_READ_TOOLS = new Set([
	"read",
	"search",
	"grep",
	"find",
	"glob",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_diagnostics",
	"web_search",
	"web_fetch",
	"mcp",
	"ast_grep",
	"task",
]);

export const DEFAULT_WRITE_TOOLS = new Set([
	"edit",
	"write",
	"lsp_rename",
	"ask_user",
	"ask_user_question",
	"steer_subagent",
	"Agent",
]);

export const DEFAULT_NEUTRAL_TOOLS = new Set(["set_phase", "set_model"]);

const HYPOTHESIS_REMINDER =
	"Exploration guard: %d consecutive read-only turns. If you have a clear hypothesis, test it with one targeted command. If you are building context before writing or planning, consider whether you have enough — and if so, take the next concrete action.";

const MANDATORY_STEER =
	"Exploration guard: %d consecutive read-only turns. You must take a concrete action this turn: run a targeted test, make an edit, write a plan, or ask the user a question. Do not read further without a clear reason.";

export class ExplorationGuard {
	private readonly readTools: Set<string>;
	private readonly writeTools: Set<string>;
	private readonly hypothesisThreshold: number;
	private readonly steerThreshold: number;
	private readonly isEnabled: () => boolean;

	private consecutiveReadOnlyTurns = 0;
	private currentTurnHasWriteTool = false;
	private currentTurnHasAnyTool = false;
	private currentTurnHasReadTool = false;

	constructor(options: ExplorationGuardOptions = {}) {
		this.readTools = options.readTools ?? DEFAULT_READ_TOOLS;
		this.writeTools = options.writeTools ?? DEFAULT_WRITE_TOOLS;
		this.hypothesisThreshold = options.hypothesisThreshold ?? 5;
		this.steerThreshold = options.steerThreshold ?? 8;
		this.isEnabled = options.isEnabled ?? (() => true);
	}

	reset(): void {
		this.consecutiveReadOnlyTurns = 0;
		this.currentTurnHasWriteTool = false;
		this.currentTurnHasAnyTool = false;
		this.currentTurnHasReadTool = false;
	}

	turnStart(): void {
		this.currentTurnHasWriteTool = false;
		this.currentTurnHasAnyTool = false;
		this.currentTurnHasReadTool = false;
	}

	/** Track a tool call within the current turn. */
	recordToolCall(toolName: string): void {
		this.currentTurnHasAnyTool = true;
		if (this.writeTools.has(toolName)) {
			this.currentTurnHasWriteTool = true;
		}
		if (this.readTools.has(toolName)) {
			this.currentTurnHasReadTool = true;
		}
	}

	/**
	 * End of turn — evaluate the streak.
	 * @param sendSteer Called with a steer message when the threshold is hit.
	 *                 If omitted, the guard still tracks internally.
	 */
	turnEnd(sendSteer?: (text: string) => void): void {
		if (!this.isEnabled()) {
			this.consecutiveReadOnlyTurns = 0;
			return;
		}

		if (!this.currentTurnHasAnyTool || this.currentTurnHasWriteTool || !this.currentTurnHasReadTool) {
			this.consecutiveReadOnlyTurns = 0;
			return;
		}

		this.consecutiveReadOnlyTurns++;

		if (this.consecutiveReadOnlyTurns === this.hypothesisThreshold && sendSteer) {
			sendSteer(HYPOTHESIS_REMINDER.replace("%d", String(this.hypothesisThreshold)));
		}
		if (this.consecutiveReadOnlyTurns === this.steerThreshold && sendSteer) {
			sendSteer(MANDATORY_STEER.replace("%d", String(this.steerThreshold)));
			this.consecutiveReadOnlyTurns = 0;
		}
	}

	/** Call when user input is received — resets the streak. */
	onUserInput(): void {
		this.consecutiveReadOnlyTurns = 0;
	}

	getConsecutiveReadOnlyTurns(): number {
		return this.consecutiveReadOnlyTurns;
	}

	isReadOnly(tool: string): boolean {
		return this.readTools.has(tool) && !this.writeTools.has(tool);
	}
}
