/**
 * FasRunner — Orchestrator for the ferment lifecycle.
 *
 * Drives a Ferment to completion by repeatedly:
 *   1. Asking the engine for the next action
 *   2. Executing that action (prompting the agent, running verifications, etc.)
 *   3. Applying the resulting command back to the state machine
 *   4. Persisting the updated ferment
 */

import { type BashResult, executeBash } from "../../exec/bash-executor.js";
import type { AgentSession } from "../../session/agent-session.js";
import type { FermentCommand } from "../commands.js";
import { applyTransition } from "../state-machine.js";
import type { Ferment, Phase, Step, StepResult } from "../types.js";
import type { FasAction, FasEngine } from "./engine.js";
import type { FasPlanner } from "./planner.js";
import type { FasState } from "./state.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface FasRunnerConfig {
	session: AgentSession;
	state: FasState;
	engine: FasEngine;
	planner?: FasPlanner;
	hooks?: import("./engine.js").FasEngineHooks[];
	/** Max turns (prompt iterations) per step before auto-fail. Default 8. */
	maxStepTurns?: number;
	/** Max retry attempts for a failed step. Default 1. */
	maxStepAttempts?: number;
	/** Global timeout for the entire ferment in ms. Default 30 min. */
	globalTimeoutMs?: number;
}

export interface FasRunnerRunOptions {
	/** Resume an existing ferment by ID instead of creating a new one. */
	resumeId?: string;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export class FasRunner {
	readonly #config: FasRunnerConfig;
	readonly #abortController = new AbortController();
	#isRunning = false;
	#pauseRequested = false;
	#stepRetryCount = new Map<string, number>();
	#currentFerment: Ferment | undefined = undefined;

	constructor(config: FasRunnerConfig) {
		this.#config = {
			maxStepTurns: 8,
			maxStepAttempts: 1,
			globalTimeoutMs: 30 * 60 * 1000,
			...config,
		};
		for (const hook of this.#config.hooks ?? []) {
			this.#config.engine.registerHook(hook);
		}
	}

	// ─── Public API ─────────────────────────────────────────────────────────

	/**
	 * Main entry point. Creates or resumes a ferment and executes it to completion.
	 *
	 * Flow:
	 *  1. Initialise ferment (new via planner, or resume from state)
	 *  2. Bootstrap engine with the ferment
	 *  3. Main loop: next() → executeAction() → applyTransition() → save()
	 *  4. Return final ferment state
	 */
	async run(_goal: string, options?: FasRunnerRunOptions): Promise<Ferment> {
		if (this.#isRunning) {
			throw new Error("FasRunner is already running.");
		}
		this.#isRunning = true;
		this.#pauseRequested = false;
		this.#stepRetryCount.clear();

		let ferment: Ferment;

		if (options?.resumeId) {
			const loaded = this.#config.state.get(options.resumeId);
			if (!loaded) {
				throw new Error(`Ferment "${options.resumeId}" not found.`);
			}
			ferment = loaded;
		} else {
			if (!this.#config.planner) {
				throw new Error("No planner configured and no resumeId provided.");
			}
			ferment = await this.#config.planner.create();
		}

		this.#currentFerment = ferment;
		this.#config.engine.setFerment(ferment);
		this.#config.state.save(ferment);

		// Main execution loop
		while (this.#isRunning && !this.#abortController.signal.aborted) {
			// Honour pause requests at the top of each iteration
			if (this.#pauseRequested) {
				ferment = this.#pauseFerment(ferment);
				this.#currentFerment = ferment;
				this.#config.state.save(ferment);
				this.#isRunning = false;
				return ferment;
			}

			const action = this.#config.engine.next();
			if (action === undefined) {
				// Terminal state — nothing more to do
				this.#isRunning = false;
				return ferment;
			}

			// Handle special pause sentinel emitted by the engine
			if (action.kind === "paused") {
				ferment = this.#pauseFerment(ferment);
				this.#currentFerment = ferment;
				this.#config.state.save(ferment);
				this.#isRunning = false;
				return ferment;
			}

			// Execute the action and build the corresponding command
			const result = await this.#executeAction(action);

			// scope: planner.create() already handled this; skip if returned by engine
			if (action.kind === "scope") {
				continue;
			}

			const cmd = this.#buildCommand(action, result);
			if (!cmd) {
				// No command needed (e.g., refine that is a no-op)
				continue;
			}

			const transitioned = applyTransition(ferment, cmd);
			if ("error" in transitioned) {
				throw new Error(`Transition error for action "${action.kind}": ${transitioned.error}`);
			}

			ferment = transitioned;
			this.#currentFerment = ferment;
			this.#config.engine.setFerment(ferment);
			this.#config.state.save(ferment);
		}

		this.#isRunning = false;
		return ferment;
	}

	/** Request pause at the next loop iteration. Returns immediately. */
	pause(): Promise<void> {
		this.#pauseRequested = true;
		return Promise.resolve();
	}

	/** Resume a paused ferment and continue execution. */
	async resume(fermentId: string): Promise<Ferment> {
		const ferment = this.#config.state.get(fermentId);
		if (!ferment) {
			throw new Error(`Ferment "${fermentId}" not found.`);
		}
		if (ferment.status !== "paused") {
			throw new Error(`Ferment "${fermentId}" is "${ferment.status}", expected "paused".`);
		}

		const resumed = applyTransition(ferment, { type: "resume" });
		if ("error" in resumed) {
			throw new Error(`Resume transition failed: ${resumed.error}`);
		}

		this.#currentFerment = resumed;
		this.#config.engine.setFerment(resumed);
		this.#config.state.save(resumed);
		this.#isRunning = false; // will be set to true by run()
		return this.run(resumed.goal ?? "", { resumeId: resumed.id });
	}

	/** Abort execution immediately. The next prompt() call will throw AbortError. */
	abort(): void {
		this.#abortController.abort();
		this.#isRunning = false;
	}

	// ─── Action execution ────────────────────────────────────────────────────

	/**
	 * Execute a single action from the engine.
	 * Returns a StepResult for step-related actions; undefined for others.
	 */
	async #executeAction(action: FasAction): Promise<StepResult | undefined> {
		switch (action.kind) {
			case "scope":
				// Planner.create() already produced the scoped ferment — nothing to do
				return undefined;

			case "activate_phase":
			case "complete_phase":
			case "complete_ferment":
				// Pure state transitions — nothing to execute
				return undefined;

			case "refine": {
				// The planner already generated steps when it created the ferment.
				// This action should rarely fire. Treat as a no-op: the phase already
				// has steps from the plan, so we just return undefined and let the
				// next engine.next() move on to start_step.
				return undefined;
			}

			case "start_step":
				return this.#executeStartStep(action as any);

			case "verify":
				return this.#executeVerify(action as any);

			case "complete_step":
				// Completed by #executeStartStep after agent work or verification
				return undefined;

			case "recover_step":
				return this.#executeRecoverStep(action as any);

			case "recover_phase":
				// Reactivate the phase so the engine picks it up again
				return undefined;

			case "paused":
				return undefined;

			default: {
				const _exhaustive: any = action;
				return undefined;
			}
		}
	}

	/** Handle start_step: mark running → prompt agent → verify or complete. */
	async #executeStartStep(action: FasAction & { kind: "start_step" }): Promise<StepResult> {
		const phaseId = action.phaseId!;
		const stepId = action.stepId!;

		// Apply start_step to move from pending → running
		const startCmd: FermentCommand = { type: "start_step", phaseId, stepId };
		let fermentState = this.#getCurrentFerment();
		const transitioned = applyTransition(fermentState, startCmd);
		if ("error" in transitioned) {
			throw new Error(`start_step transition failed: ${transitioned.error}`);
		}
		fermentState = transitioned;
		this.#currentFerment = fermentState;
		this.#config.engine.setFerment(fermentState);
		this.#config.state.save(fermentState);

		// Locate the phase and step for building the prompt
		const phase = fermentState.phases.find(p => p.id === phaseId);
		if (!phase) throw new Error(`Phase "${phaseId}" not found.`);
		const step = phase.steps.find(s => s.id === stepId);
		if (!step) throw new Error(`Step "${stepId}" not found in phase "${phaseId}".`);

		// Check abort signal before prompting
		if (this.#abortController.signal.aborted) {
			throw new Error("AbortError");
		}

		// Prompt the agent to execute the step
		const promptText = this.#buildStepPrompt(phase, step);
		await this.#config.session.prompt(promptText);

		// After the agent finishes, proceed to verification or complete the step
		if (step.verification?.command) {
			// Run verification
			const verified = await this.#runVerification(step, phase);
			return verified;
		} else {
			// No verification — mark step as done with agent's work accepted
			const now = new Date().toISOString();
			const result: StepResult = { success: true, completedAt: now };
			const completeCmd: FermentCommand = {
				type: "complete_step",
				phaseId,
				stepId,
				result,
			};
			const next = applyTransition(fermentState, completeCmd);
			if ("error" in next) {
				throw new Error(`complete_step transition failed: ${next.error}`);
			}
			this.#currentFerment = next;
			this.#config.engine.setFerment(next);
			this.#config.state.save(next);
			return result;
		}
	}

	/** Handle verify: run the step's verification command. */
	async #executeVerify(action: FasAction & { kind: "verify" }): Promise<StepResult> {
		const phaseId = action.phaseId!;
		const stepId = action.stepId!;

		const ferment = this.#getCurrentFerment();
		const phase = ferment.phases.find(p => p.id === phaseId);
		if (!phase) throw new Error(`Phase "${phaseId}" not found.`);
		const step = phase.steps.find(s => s.id === stepId);
		if (!step) throw new Error(`Step "${stepId}" not found.`);

		const verified = await this.#runVerification(step, phase);
		return verified;
	}

	/** Handle recover_step: retry or fail the step. */
	async #executeRecoverStep(action: FasAction & { kind: "recover_step" }): Promise<StepResult | undefined> {
		const phaseId = action.phaseId!;
		const stepId = action.stepId!;
		const key = `${phaseId}:${stepId}`;
		const attempts = this.#stepRetryCount.get(key) ?? 0;
		const max = this.#config.maxStepAttempts ?? 1;

		if (attempts < max) {
			this.#stepRetryCount.set(key, attempts + 1);
			// Re-execute the step (start_step transition is re-applied inside executeStartStep)
			return this.#executeStartStep({ kind: "start_step", phaseId, stepId, message: action.message });
		} else {
			// Exhausted retries — fail the step
			const failCmd: FermentCommand = { type: "fail_step", phaseId, stepId, error: "Max retries exceeded." };
			const ferment = this.#getCurrentFerment();
			const transitioned = applyTransition(ferment, failCmd);
			if ("error" in transitioned) {
				throw new Error(`fail_step transition failed: ${transitioned.error}`);
			}
			this.#currentFerment = transitioned;
			this.#config.engine.setFerment(transitioned);
			this.#config.state.save(transitioned);
			return undefined;
		}
	}

	// ─── Verification ────────────────────────────────────────────────────────

	/** Run a step's verification command and apply verify_step or fail_step. */
	async #runVerification(step: Step, phase: Phase): Promise<StepResult> {
		const command = step.verification?.command;
		if (!step.verification || !command) {
			throw new Error(`Step "${step.id}" has no verification command.`);
		}

		const now = new Date().toISOString();
		const retries = step.verification.retries ?? 0;
		let lastResult: StepResult | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			const bashResult: BashResult = await executeBash(command, {
				signal: this.#abortController.signal,
			});

			lastResult = {
				success: bashResult.exitCode === 0 && !bashResult.cancelled,
				stdout: bashResult.output,
				stderr: undefined,
				exitCode: bashResult.exitCode,
				completedAt: now,
			};

			if (lastResult.success) {
				break;
			}

			// Wait before retrying verification
			if (attempt < retries) {
				const delayMs = step.verification.retryDelayMs ?? 1000;
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
		}

		const stepResult = lastResult!;
		const phaseId = phase.id;
		const stepId = step.id;

		if (stepResult.success) {
			const cmd: FermentCommand = { type: "verify_step", phaseId, stepId, result: stepResult };
			const ferment = this.#getCurrentFerment();
			const transitioned = applyTransition(ferment, cmd);
			if ("error" in transitioned) {
				throw new Error(`verify_step transition failed: ${transitioned.error}`);
			}
			this.#currentFerment = transitioned;
			this.#config.engine.setFerment(transitioned);
			this.#config.state.save(transitioned);
		} else {
			// Verification failed — check retry count
			const key = `${phaseId}:${stepId}`;
			const attempts = this.#stepRetryCount.get(key) ?? 0;
			const max = this.#config.maxStepAttempts ?? 1;

			if (attempts < max) {
				this.#stepRetryCount.set(key, attempts + 1);
				// Retry by re-calling start_step logic
				return this.#executeStartStep({ kind: "start_step", phaseId, stepId, message: `Retry step ${step.index}` });
			} else {
				const failCmd: FermentCommand = {
					type: "fail_step",
					phaseId,
					stepId,
					error: stepResult.stderr ?? `Verification failed with exit code ${stepResult.exitCode}`,
				};
				const ferment = this.#getCurrentFerment();
				const transitioned = applyTransition(ferment, failCmd);
				if ("error" in transitioned) {
					throw new Error(`fail_step transition failed: ${transitioned.error}`);
				}
				this.#currentFerment = transitioned;
				this.#config.engine.setFerment(transitioned);
				this.#config.state.save(transitioned);
			}
		}

		return stepResult;
	}

	// ─── Command building ────────────────────────────────────────────────────

	/**
	 * Build a FermentCommand from an action and its execution result.
	 * Returns undefined for actions that don't require a state transition here.
	 */
	#buildCommand(action: FasAction, result: StepResult | undefined): FermentCommand | undefined {
		switch (action.kind) {
			case "scope":
				// Already handled by planner.create()
				return undefined;

			case "activate_phase":
				return { type: "activate_phase", phaseId: action.phaseId! };

			case "refine": {
				// Refine is a no-op: steps were already produced by the planner
				const ferment = this.#getCurrentFerment();
				const phase = ferment.phases.find(p => p.id === action.phaseId);
				if (!phase) return undefined;
				// Apply refine_phase with existing steps (no changes)
				return {
					type: "refine_phase",
					phaseId: action.phaseId!,
					steps: phase.steps.map(s => ({
						description: s.description,
						verify: s.verification?.command,
						parallel_group: s.groupIndex,
					})),
				};
			}

			case "start_step":
				// start_step is applied immediately inside #executeStartStep
				return undefined;

			case "verify":
				// Applied inside #runVerification
				return undefined;

			case "complete_step": {
				if (!action.stepId) return undefined;
				return {
					type: "complete_step",
					phaseId: action.phaseId!,
					stepId: action.stepId,
					result,
				};
			}

			case "complete_phase":
				return { type: "complete_phase", phaseId: action.phaseId!, summary: "" };

			case "complete_ferment":
				return { type: "complete_ferment", finalSummary: undefined };

			case "recover_step":
				// Handled inside #executeRecoverStep
				return undefined;

			case "recover_phase":
				return { type: "activate_phase", phaseId: action.phaseId! };

			case "paused":
				return undefined;

			default: {
				const _exhaustive: any = action;
				return undefined;
			}
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	#getCurrentFerment(): Ferment {
		return this.#currentFerment!;
	}

	#pauseFerment(ferment: Ferment): Ferment {
		const paused = applyTransition(ferment, { type: "pause" });
		if ("error" in paused) {
			throw new Error(`Pause transition failed: ${paused.error}`);
		}
		return paused;
	}

	#buildStepPrompt(phase: Phase, step: Step): string {
		return [
			"You're executing a planned step.",
			"",
			`Phase: ${phase.name}`,
			`Step ${step.index}: ${step.description}`,
			"",
			"Use the available tools to accomplish this step. When finished, summarize what was done.",
		].join("\n");
	}
}
