/**
 * Proactive context pruning decision function.
 *
 * Unlike reactive compaction (which fires after turns when threshold is exceeded),
 * this runs before each LLM prompt to decide if cheap shake+prune should run
 * proactively. This keeps context lean without expensive LLM-based summarization.
 *
 * Ported from Freebuff's context-pruner pattern.
 */

export interface ProactivePruneConfig {
	/** Total context window size in tokens. 0 disables pruning. */
	contextWindow: number;
	/** Percentage of context window that triggers pruning. e.g. 85 = prune at 85%. */
	thresholdPercent: number;
	/** Cache expiry duration in ms. e.g. 300_000 = 5 min (Anthropic prompt cache). */
	cacheExpiryMs: number;
}

export interface CacheTimestamps {
	/** Timestamp (ms) when the last assistant message was sent. */
	lastAssistantAt: number;
	/** Timestamp (ms) when the current user prompt was submitted. */
	userPromptAt: number;
}

/**
 * Decide whether proactive pruning should run before the next LLM prompt.
 *
 * Two triggers:
 * 1. Context tokens exceed thresholdPercent of contextWindow
 * 2. Prompt cache will miss (gap between last assistant and current user > cacheExpiryMs)
 */
export function shouldProactivePrune(
	contextTokens: number,
	cacheTimestamps: CacheTimestamps | undefined,
	config: ProactivePruneConfig,
): boolean {
	if (config.contextWindow <= 0) return false;

	// Threshold check
	const threshold = config.contextWindow * (config.thresholdPercent / 100);
	if (contextTokens > threshold) return true;

	// Cache expiry check
	if (cacheTimestamps) {
		const gap = cacheTimestamps.userPromptAt - cacheTimestamps.lastAssistantAt;
		if (gap > config.cacheExpiryMs) return true;
	}

	return false;
}
