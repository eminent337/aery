/**
 * Autonomous Mode Runtime
 * 
 * Core engine for bounded autonomous execution with quality gates.
 * Integrates with Ferment for structured workflow orchestration.
 */

import { Snowflake } from "@aryee337/aery-utils";
import type {
	AutonomousBudget,
	AutonomousEvent,
	AutonomousFermentConfig,
	AutonomousResult,
	AutonomousRuntimeHost,
	AutonomousState,
	AutonomousStatus,
	QualityGate,
} from "./types.js";

/** Default budget limits */
const DEFAULT_BUDGET: AutonomousBudget = {
	tokens: 50000,
	timeMs: 30 * 60 * 1000, // 30 minutes
	turns: 100,
};

/** Default quality gate retries */
const DEFAULT_GATE_RETRIES = 3;

/** Return type for turn completion check */
export interface TurnCompleteResult {
	shouldContinue: boolean;
	continuationPrompt?: string;
	result?: AutonomousResult;
}

export class AutonomousRuntime {
	readonly #host: AutonomousRuntimeHost;
	#state: AutonomousState | null = null;

	constructor(host: AutonomousRuntimeHost) {
		this.#host = host;
	}

	get state(): AutonomousState | null {
		return this.#state;
	}

	get isEnabled(): boolean {
		return this.#state?.enabled ?? false;
	}

	get status(): AutonomousStatus {
		return this.#state?.status ?? "idle";
	}

	get tokensUsed(): number {
		return this.#state?.tokensUsed ?? 0;
	}

	get timeUsedMs(): number {
		return this.#state?.timeUsedMs ?? 0;
	}

	get turnsUsed(): number {
		return this.#state?.turnsUsed ?? 0;
	}

	/**
	 * Start autonomous execution with the given objective and config.
	 */
	async start(input: {
		objective: string;
		config?: AutonomousFermentConfig;
	}): Promise<AutonomousState> {
		const objective = input.objective.trim();
		if (!objective) {
			throw new Error("Objective is required");
		}

		const config = input.config ?? {};
		const budget = { ...DEFAULT_BUDGET, ...config.budget };
		const gates = (config.gates ?? []).map(g => ({
			...g,
			retries: g.retries ?? DEFAULT_GATE_RETRIES,
		}));

		const now = this.#host.now();
		const state: AutonomousState = {
			id: String(Snowflake.next()),
			objective,
			status: "active",
			budget,
			gates,
			tokensUsed: 0,
			timeUsedMs: 0,
			turnsUsed: 0,
			enabled: true,
			continuationPrompt: config.continuationPrompt ?? this.#defaultContinuationPrompt(objective),
			createdAt: now,
			updatedAt: now,
		};

		this.#state = state;
		this.#host.emit({ type: "started", state });
		await this.#host.persist(state);

		return state;
	}

	/**
	 * Pause autonomous execution.
	 */
	async pause(): Promise<AutonomousState> {
		if (!this.#state) {
			throw new Error("No active autonomous session");
		}
		if (this.#state.status === "complete" || this.#state.status === "aborted") {
			throw new Error(`Cannot pause: session is ${this.#state.status}`);
		}

		this.#state.status = "paused";
		this.#state.enabled = false;
		this.#state.updatedAt = this.#host.now();
		
		this.#host.emit({ type: "paused" });
		await this.#host.persist(this.#state);

		return this.#state;
	}

	/**
	 * Resume autonomous execution.
	 */
	async resume(): Promise<AutonomousState> {
		if (!this.#state) {
			throw new Error("No active autonomous session");
		}
		if (this.#state.status !== "paused") {
			throw new Error(`Cannot resume: session is ${this.#state.status}`);
		}

		this.#state.status = "active";
		this.#state.enabled = true;
		this.#state.updatedAt = this.#host.now();
		
		this.#host.emit({ type: "resumed" });
		await this.#host.persist(this.#state);

		return this.#state;
	}

	/**
	 * Abort autonomous execution.
	 */
	async abort(reason?: string): Promise<AutonomousState> {
		if (!this.#state) {
			throw new Error("No active autonomous session");
		}
		if (this.#state.status === "complete") {
			return this.#state;
		}

		this.#state.status = "aborted";
		this.#state.enabled = false;
		this.#state.updatedAt = this.#host.now();
		
		this.#host.emit({ type: "aborted", reason });
		await this.#host.persist(this.#state);

		return this.#state;
	}

	/**
	 * Complete autonomous execution (objective achieved).
	 */
	async complete(): Promise<AutonomousResult> {
		if (!this.#state) {
			throw new Error("No active autonomous session");
		}
		if (this.#state.status === "complete" || this.#state.status === "aborted") {
			return this.#buildResult();
		}

		this.#state.status = "complete";
		this.#state.enabled = false;
		this.#state.updatedAt = this.#host.now();
		
		this.#host.emit({ type: "completed", finalState: this.#state });
		await this.#host.persist(this.#state);

		return this.#buildResult();
	}

	/**
	 * Process a turn completion and update state.
	 */
	async onTurnComplete(): Promise<TurnCompleteResult> {
		if (!this.#state || !this.#state.enabled) {
			return { shouldContinue: false };
		}

		// Update turn count and usage
		this.#state.turnsUsed += 1;
		const usage = this.#host.getCurrentUsage();
		this.#state.tokensUsed = usage.input + usage.output;
		this.#state.timeUsedMs = this.#host.now() - this.#state.createdAt;
		this.#state.updatedAt = this.#host.now();

		this.#host.emit({
			type: "turn_completed",
			turnsUsed: this.#state.turnsUsed,
			tokensUsed: this.#state.tokensUsed,
		});

		// Check budget
		const budgetCheck = this.#checkBudget();
		if (!budgetCheck.ok) {
			this.#state.status = "budget-exhausted";
			this.#state.enabled = false;
			this.#host.emit({ type: "budget_check", ...budgetCheck });
			await this.#host.persist(this.#state);
			return { shouldContinue: false, result: this.#buildResult() };
		}

		// Run quality gates
		const gateResult = await this.#runQualityGates();
		if (!gateResult.ok) {
			this.#state.status = "gate-failed";
			this.#state.lastGateFailure = gateResult.error;
			this.#state.updatedAt = this.#host.now();
			this.#host.emit({
				type: "gate_failed",
				gateName: gateResult.gateName,
				error: gateResult.error,
				retries: gateResult.retries,
			});
			await this.#host.persist(this.#state);
			return { shouldContinue: false };
		}

		// Check if we should continue
		const shouldContinue = this.#shouldContinue();
		if (shouldContinue) {
			this.#state.updatedAt = this.#host.now();
			await this.#host.persist(this.#state);
			return {
				shouldContinue: true,
				continuationPrompt: this.#state.continuationPrompt,
			};
		}

		// Exit gracefully
		return { shouldContinue: false };
	}

	/**
	 * Get continuation prompt for the LLM.
	 */
	getContinuationPrompt(): string | undefined {
		if (!this.#state || !this.#state.enabled) {
			return undefined;
		}
		return this.#state.continuationPrompt;
	}

	/**
	 * Check if autonomous mode should continue.
	 */
	#shouldContinue(): boolean {
		if (!this.#state) return false;
		if (this.#state.status !== "active") return false;
		
		const budgetCheck = this.#checkBudget();
		return budgetCheck.ok;
	}

	/**
	 * Check budget constraints.
	 */
	#checkBudget(): { ok: boolean; tokensUsed: number; timeUsedMs: number; turnsUsed: number } {
		if (!this.#state) {
			return { ok: true, tokensUsed: 0, timeUsedMs: 0, turnsUsed: 0 };
		}

		const { tokens, timeMs, turns } = this.#state.budget;
		const tokensOk = tokens === undefined || this.#state.tokensUsed < tokens;
		const timeOk = timeMs === undefined || this.#state.timeUsedMs < timeMs;
		const turnsOk = turns === undefined || this.#state.turnsUsed < turns;

		return {
			ok: tokensOk && timeOk && turnsOk,
			tokensUsed: this.#state.tokensUsed,
			timeUsedMs: this.#state.timeUsedMs,
			turnsUsed: this.#state.turnsUsed,
		};
	}

	/**
	 * Run quality gates and return result.
	 */
	async #runQualityGates(): Promise<
		| { ok: true }
		| { ok: false; gateName: string; error: string; retries: number }
	> {
		if (!this.#state || this.#state.gates.length === 0) {
			return { ok: true };
		}

		for (const gate of this.#state.gates) {
			try {
				const result = await this.#host.executeCommand(gate.command);
				
				if (result.exitCode === 0) {
					this.#host.emit({ type: "gate_passed", gateName: gate.name });
					gate.retries = 0;
					continue;
				}

				// Gate failed
				gate.retries = (gate.retries ?? 0) + 1;
				const error = `Gate '${gate.name}' failed with exit code ${result.exitCode}: ${result.stderr.slice(0, 500)}`;
				
				this.#host.emit({
					type: "gate_failed",
					gateName: gate.name,
					error,
					retries: gate.retries,
				});

				if (gate.retries >= (gate.maxRetries ?? DEFAULT_GATE_RETRIES)) {
					return { ok: false, gateName: gate.name, error, retries: gate.retries };
				}
			} catch (err) {
				const error = `Gate '${gate.name}' error: ${err instanceof Error ? err.message : String(err)}`;
				this.#host.emit({ type: "gate_failed", gateName: gate.name, error, retries: 0 });
				return { ok: false, gateName: gate.name, error, retries: 0 };
			}
		}

		return { ok: true };
	}

	/**
	 * Build final result.
	 */
	#buildResult(): AutonomousResult {
		if (!this.#state) {
			return {
				success: false,
				state: this.#createInitialState(),
				totalTokens: 0,
				totalTimeMs: 0,
				totalTurns: 0,
			};
		}

		return {
			success: this.#state.status === "complete",
			state: this.#state,
			totalTokens: this.#state.tokensUsed,
			totalTimeMs: this.#state.timeUsedMs,
			totalTurns: this.#state.turnsUsed,
		};
	}

	#createInitialState(): AutonomousState {
		return {
			id: "",
			objective: "",
			status: "idle",
			budget: DEFAULT_BUDGET,
			gates: [],
			tokensUsed: 0,
			timeUsedMs: 0,
			turnsUsed: 0,
			enabled: false,
			createdAt: 0,
			updatedAt: 0,
		};
	}

	/**
	 * Generate default continuation prompt.
	 */
	#defaultContinuationPrompt(objective: string): string {
		return `Continue working toward the objective.

<objective>
${objective}
</objective>

Autonomous state:
- Tokens used: ${this.tokensUsed}
- Time used: ${Math.round(this.timeUsedMs / 1000)}s
- Turns: ${this.turnsUsed}

Do not mark complete until the objective is fully achieved. Run quality gates before completing.`;
	}
}

/**
 * Create an autonomous runtime instance.
 */
export function createAutonomousRuntime(host: AutonomousRuntimeHost): AutonomousRuntime {
	return new AutonomousRuntime(host);
}
