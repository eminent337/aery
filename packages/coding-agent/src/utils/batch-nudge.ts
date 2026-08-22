/**
 * Batch tool nudge for Aery.
 *
 * Port of jcode's sequential tool use nudge (`crates/jcode-app-core/src/agent/turn_loops.rs`).
 * Detects sequential single-tool patterns and injects a system-reminder to encourage batching.
 */

export const SEQUENTIAL_TOOL_ROUNDS_BEFORE_BATCH_NUDGE = 3;

export const BATCH_NUDGE_MESSAGE =
	"<system-reminder>Several tool calls have been made one at a time. If the next independent operations can run concurrently, use the batch tool instead of making more sequential calls. Keep sequential calls when one result is required to decide the next operation.</system-reminder>";

/**
 * Update the sequential tool rounds counter.
 * Resets to 0 when parallel or batch calls are used.
 * Increments by 1 for sequential single-tool rounds.
 */
export function updateSequentialToolRounds(
	current: number,
	toolCount: number,
	usedBatch: boolean,
): number {
	if (toolCount === 1 && !usedBatch) {
		return current + 1;
	}
	return 0;
}

/**
 * Whether a batch nudge should be injected.
 * Only fires when nudge is pending and the batch tool is available.
 */
export function shouldInjectBatchNudge(pending: boolean, batchAvailable: boolean): boolean {
	return pending && batchAvailable;
}

/**
 * Check if a batch tool is available in the current tool list.
 */
export function batchToolAvailable(tools: Array<{ name: string }>): boolean {
	return tools.some(tool => tool.name === "batch");
}
