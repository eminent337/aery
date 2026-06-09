/**
 * Ferment extension event handlers.
 *
 * Registers lifecycle handlers on the ExtensionAPI to:
 * - Restore a persisted active ferment on session_start
 * - Save state and clear timers on session_shutdown
 * - Send a follow-up nudge to the agent when an active ferment
 *   exists and continuation policy is "automated" (turn_end)
 * - Inject reactive continuation nudges when the agent stalls
 *   without tool calls (turn_end)
 * - Update footer status bar with current ferment state (turn_end)
 * - Trigger plan review when the agent finishes (agent_end)
 */

import type { ExtensionAPI, ExtensionContext } from "../../extensibility/extensions/types.js";
import { FermentStore } from "../store.js";
import type { Ferment } from "../types.js";
import { formatFermentFooter } from "./footer-status.js";
import { maybeInjectReactiveContinuationNudge, resetReactiveContinuationNudgeCount } from "./nudge.js";
import { clearProgressWidget, setProgressWidget } from "./progress-overlay.js";
import { scheduleFermentWakeUp } from "./scheduler.js";
import { getActive, getActiveId, type getContinuationPolicy, setActive } from "./state.js";

/**
 * Register all ferment event handlers on the ExtensionAPI.
 */
export function registerFermentEvents(
	api: ExtensionAPI,
	_runtime: {
		getActive: typeof getActive;
		setActive: typeof setActive;
		getContinuationPolicy: typeof getContinuationPolicy;
	},
): void {
	// ── session_start ────────────────────────────────────────────────────────
	api.on("session_start", async () => {
		const store = FermentStore.open();
		const activeId = getActiveId();
		if (!activeId) return;

		const persisted = store.get(activeId) as Ferment | null;
		if (persisted) {
			setActive(persisted);
		}
	});

	// ── session_shutdown ─────────────────────────────────────────────────────
	api.on("session_shutdown", () => {
		// Save active ferment to persistence before shutdown
		const f = getActive();
		if (f) {
			const store = FermentStore.open();
			store.save(f as Ferment & Record<string, unknown>);
		}
		// Widget/footer will naturally reset on next session start
	});

	// ── turn_end ─────────────────────────────────────────────────────────────
	api.on("turn_end", async (event, _ctx: ExtensionContext) => {
		const content = (event.message as { content?: unknown })?.content;
		const hasToolCall =
			Array.isArray(content) && content.some((c: { type: string; name?: string }) => c.type === "toolCall");

		if (hasToolCall && getActive()) {
			// Agent made tool calls — reset the stall counter
			const f = getActive();
			if (f) resetReactiveContinuationNudgeCount(f.id);
		}

		// Automated continuation nudge (scheduled)
		scheduleFermentWakeUp(api);

		// Reactive continuation nudge — if the agent stalled without tool calls
		if (!hasToolCall) {
			maybeInjectReactiveContinuationNudge(api);
		}

		// Footer status bar update
		const footer = formatFermentFooter();
		_ctx?.ui?.setStatus?.("ferment", footer.visible ? footer.text : undefined);

		// Persistent progress widget update
		if (_ctx?.ui) {
			if (getActive()) {
				setProgressWidget(_ctx.ui);
			} else {
				clearProgressWidget(_ctx.ui);
			}
		}
	});

	// ── agent_end ─────────────────────────────────────────────────────────────
	// Placeholder: trigger plan review if a review is pending.
	api.on("agent_end", async (_event, _ctx) => {
		// TODO: check if Ferment has a pending plan-review flag; if so, trigger it.
	});
}
