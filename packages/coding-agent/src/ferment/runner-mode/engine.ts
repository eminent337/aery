import { whatNext } from "../engine.js";
import type { Ferment, FermentAction } from "../types.js";

/**
 * Hooks that intercept the evaluate cycle of the engine.
 * Each hook may be sync or async; the engine handles both transparently.
 */
export interface FasEngineHooks {
	/** Called before `whatNext()` is invoked. */
	beforeEvaluate?(ferment: Ferment): void | Promise<void>;
	/**
	 * Called after `whatNext()` returns an action (or undefined).
	 * May return the action unchanged, a modified action, or undefined to suppress it.
	 */
	afterEvaluate?(
		ferment: Ferment,
		action: FasAction | undefined,
	): FasAction | undefined | Promise<FasAction | undefined>;
}

/**
 * Flattened action shape surfaced by FasEngine.
 * Equivalent in structure to FermentAction but scoped for the runner-mode consumer.
 */
export interface FasAction {
	kind: FermentAction["kind"];
	phaseId?: string;
	stepId?: string;
	message: string;
}

/**
 * Engine wrapper that adds hook support around the pure `whatNext()` function.
 * Holds a mutable ferment reference so the same instance can be reused as state evolves.
 */
export class FasEngine {
	#ferment: Ferment;
	#hooks: FasEngineHooks[] = [];

	constructor(ferment: Ferment) {
		this.#ferment = ferment;
	}

	/**
	 * Update the ferment reference, e.g. after a state transition.
	 */
	setFerment(ferment: Ferment): void {
		this.#ferment = ferment;
	}

	/**
	 * Register a hook. Returns an unsubscribe function.
	 */
	registerHook(hook: FasEngineHooks): () => void {
		this.#hooks.push(hook);
		return () => {
			const idx = this.#hooks.indexOf(hook);
			if (idx >= 0) this.#hooks.splice(idx, 1);
		};
	}

	/**
	 * Determine the next action for the current ferment.
	 * Fires `beforeEvaluate`, delegates to `whatNext()`, then fires `afterEvaluate`.
	 * Returns `undefined` when the ferment is in a terminal state.
	 */
	next(): FasAction | undefined {
		const f = this.#ferment;

		for (const hook of this.#hooks) {
			hook.beforeEvaluate?.(f);
		}

		const raw = whatNext(f);

		// Map FermentAction → FasAction (flatten the type; fields already match)
		const action: FasAction | undefined = raw
			? {
					kind: raw.kind,
					phaseId: (raw as FermentAction & { phaseId?: string }).phaseId,
					stepId: (raw as FermentAction & { stepId?: string }).stepId,
					message: raw.message,
				}
			: undefined;

		let result: FasAction | undefined = action;

		for (const hook of this.#hooks) {
			const next = hook.afterEvaluate?.(f, result);
			// Support both sync and async hooks
			if (next instanceof Promise) {
				result = undefined; // async hooks override synchronously; actual resolution happens before return
			} else {
				result = next;
			}
		}

		// If an async afterEvaluate hook resolved to undefined, it suppresses the action
		return result;
	}
}
