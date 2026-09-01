import { isFreeTierModelId } from "./free-tier";

/**
 * Privacy policy resolution: model -> tier, then tier -> enforcement mode.
 *
 * This is the single decision point the chokepoint in stream.ts consults.
 * It is intentionally dependency-free (no coding-agent imports) so the
 * policy stays settable at runtime by the host application.
 *
 * Tiers:
 *  - "data-collecting" — free opencode zen models whose terms permit the
 *    provider to retain/train on prompts and completions (muse-spark,
 *    big-pickle, mimo, ling, nemotrons, and any other `-free` zen id).
 *  - "zero-retention" — everything else (paid zen, user's own Claude/OpenAI
 *    keys, local ollama, etc.).
 *
 * Modes (per model, resolved from the injectable policy provider):
 *  - "block" — never allow the request through (default for data-collecting).
 *  - "warn" — allow through but record an audit event.
 *  - "off" — no intercept.
 */

export type PrivacyTier = "data-collecting" | "zero-retention";
export type PrivacyMode = "block" | "warn" | "off";

export interface PrivacyPolicy {
	/** Resolve the enforcement mode for a model id. */
	resolveMode(modelId: string, tier: PrivacyTier): PrivacyMode;
	/** Optional extra model ids to treat as data-collecting (extensible list). */
	extraDataCollecting: ReadonlySet<string>;
}

/** Default policy: block data-collecting models, pass through everything else. */
const DEFAULT_REDUCER: PrivacyPolicy = {
	resolveMode(_modelId, tier) {
		return tier === "data-collecting" ? "block" : "off";
	},
	extraDataCollecting: new Set<string>(),
};

let activePolicy: PrivacyPolicy = DEFAULT_REDUCER;

/**
 * Install a custom policy (e.g. from a settings UI that lets the user pick
 * block/warn/off per model). Passing null restores the default.
 */
export function setPrivacyPolicy(policy: PrivacyPolicy | null): void {
	activePolicy = policy ?? DEFAULT_REDUCER;
}

/** Read the current policy (for UI, tests, or diagnostics). */
export function getPrivacyPolicy(): PrivacyPolicy {
	return activePolicy;
}

export function resolvePrivacyTier(modelId: string): PrivacyTier {
	// Lowercase once, reuse for every predicate: this is the hot path every
	// LLM request passes through, so extra toLowerCase() calls cost real
	// microseconds at scale.
	const lower = modelId.toLowerCase();
	if (activePolicy.extraDataCollecting.has(lower)) return "data-collecting";
	// Free-tier markers anywhere in the routing land any free model in the
	if (isFreeTierModelId(lower, true)) return "data-collecting";
	// Belt-and-suspenders: big-pickle is a zen free id that doesn't carry a
	// -free marker (the opencode-zen discovery helper covers it too, but
	// calling it here would re-lowercase and double the predicate work).
	if (lower === "big-pickle") return "data-collecting";
	return "zero-retention";
}

/** Resolve the enforcement mode for a model id (combines tier + policy). */
export function resolvePrivacyMode(modelId: string): PrivacyMode {
	const tier = resolvePrivacyTier(modelId);
	return activePolicy.resolveMode(modelId, tier);
}

/** Convenience: is this model's tier data-collecting? */
export function isDataCollectingModel(modelId: string): boolean {
	return resolvePrivacyTier(modelId) === "data-collecting";
}

/** Reset module state (for tests that install a custom policy). */
export function __resetPrivacyPolicy(): void {
	activePolicy = DEFAULT_REDUCER;
}
