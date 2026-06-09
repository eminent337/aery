/**
 * Ferment Extension — aery interactive-session plugin.
 *
 * Converts the standalone `--mode fas` ferment runner into an extension
 * that lives inside the interactive session, driven by tools and the
 * system prompt rather than a separate runner loop.
 *
 * Architecture:
 *   Agent sees ferment in system prompt → decides to call ferment tool
 *   → tool updates state → next turn agent sees new state → continues
 *   Watchdog (turn_end): if agent idles, auto-send nudge message.
 */

import type { KeyId } from "@aryee337/aery-tui";
import type { ExtensionAPI } from "../../extensibility/extensions/types.js";
import { registerFermentCommands } from "./commands.js";
import { registerFermentEvents } from "./events.js";
import { showProgressOverlay } from "./progress-overlay.js";
import { registerFermentPromptBlock } from "./prompt-block.js";
import { scheduleFermentWakeUp } from "./scheduler.js";
import { clearActive, getActive, getContinuationPolicy, setActive, setContinuationPolicy } from "./state.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerPhaseTools } from "./tools/phases.js";
import { registerStepTools } from "./tools/steps.js";

export interface FermentExtensionOptions {
	// Extensible in the future (e.g., continuation policy, persist path)
}

/**
 * Extension factory — returns a function that registers all ferment
 * hooks, tools, and commands on the ExtensionAPI.
 *
 * Usage in extensions manifest:
 *   import { createFermentExtension } from "./ferment/extension/extension.js";
 *   export default createFermentExtension();
 */
export function createFermentExtension(_options?: FermentExtensionOptions) {
	return function fermentExtension(api: ExtensionAPI): void {
		// ── State access bundle (passed to subsystems that need it) ──────────
		const runtime = {
			getActive,
			setActive,
			getContinuationPolicy,
			setContinuationPolicy,
			clearActive,
		};

		// ── Event handlers ───────────────────────────────────────────────────
		// - session_start: restore persisted active ferment
		// - session_shutdown: save active ferment, clear timers
		// - turn_end: send automated continuation nudge
		// - agent_end: trigger pending plan review (placeholder)
		registerFermentEvents(api, runtime);

		// ── Slash commands (ferment start/pause/progress/abort/…) ───────────
		registerFermentCommands(api);

		// ── Tool registrations ────────────────────────────────────────────────
		// Lifecycle: new, scope, activate, complete, pause, resume
		registerLifecycleTools(api);
		// Phases: refine, complete, skip, fail
		registerPhaseTools(api);
		// Steps: start, complete, verify, skip, fail
		registerStepTools(api);
		// Knowledge: decisions, memories
		registerKnowledgeTools(api);

		// ── System-prompt block (injected every turn) ────────────────────────
		registerFermentPromptBlock(api);

		// ── Keyboard shortcut: Ctrl+Shift+F — toggle automated continuation ───
		api.registerShortcut("ctrl+shift+f" as KeyId, {
			description: "Toggle ferment automated continuation",
			handler: async ctx => {
				const current = getContinuationPolicy();
				const next = current === "automated" ? "manual" : "automated";
				setContinuationPolicy(next);
				ctx.ui.notify(`Ferment continuation: ${next}`, "info");
				// If turning on automated mode and a ferment is active, trigger a wake-up
				if (next === "automated" && getActive()) {
					scheduleFermentWakeUp(api);
				}
			},
		});

		// ── Keyboard shortcut: F6 — show ferment progress overlay ──────────────
		api.registerShortcut("f6" as KeyId, {
			description: "Show ferment progress overlay",
			handler: async ctx => {
				await showProgressOverlay(ctx, api);
			},
		});
	};
}
