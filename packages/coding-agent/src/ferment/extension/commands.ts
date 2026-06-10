/**
 * Ferment slash commands for /ferment.
 * Subcommands: start, pause, resume, progress, abort, policy, list, switch, delete, one-shot
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../../extensibility/extensions/types.js";
import { whatNext } from "../engine.js";
import { applyTransition } from "../state-machine.js";
import { FermentStore } from "../store.js";
import type { Ferment } from "../types.js";
import { showProgressOverlay } from "./progress-overlay.js";
import { clearActive, getActive, getContinuationPolicy, setActive, setContinuationPolicy } from "./state.js";

/** Create a minimal ferment from a user-provided goal. */
function createMinimalFerment(goal: string, cwd: string): Ferment {
	const now = new Date().toISOString();
	const id = `ferment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	return {
		id,
		name: goal.slice(0, 40),
		status: "draft",
		goal,
		worktree: { path: cwd },
		scoping: {
			goal: { answer: goal, confirmedAt: now },
		},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	};
}

export function registerFermentCommands(api: ExtensionAPI): void {
	api.registerCommand("ferment", {
		description: "Ferment workflow commands",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const args = _args.trim().split(/\s+/).filter(Boolean);
			const sub = (args[0] ?? "").toLowerCase();

			switch (sub) {
				case "start":
				case "": {
					const store = FermentStore.open();
					const existing = store
						.listByWorktree(ctx.cwd)
						.filter(f => f.status !== "complete" && f.status !== "abandoned");

					// Show existing ferments to resume
					if (existing.length > 0) {
						const choices = existing.map(f => ({
							label: `${f.name} (${f.status})`,
							description: f.goal ?? undefined,
						}));
						choices.push({ label: "🍺  Start a new ferment", description: "Create a fresh ferment" });

						const selected = await ctx.ui.select("Resume existing or start new ferment?", choices);

						if (!selected) {
							ctx.ui.notify("ferment start cancelled", "info");
							return;
						}

						const picked = existing.find(f => `${f.name} (${f.status})` === selected);
						if (picked) {
							setActive(picked);
							setContinuationPolicy("automated");
							ctx.ui.notify(`Activated ferment "${picked.name}" (${picked.status})`, "info");
							return;
						}
						// Fall through to new-ferment prompt below
					}

					// Guided ferment start
					const examples = [
						"Rewrite login flow",
						"Add OAuth support",
						"Refactor database layer",
						"Implement caching strategy",
					];
					const defaultPrompt =
						"🍺  What would you like to ferment?\n\n" +
						"e.g. " +
						examples.map(e => `"${e}"`).join(", ") +
						"\n" +
						"(type your goal and press Enter)";

					const goal = await ctx.ui.input(defaultPrompt, "Your ferment goal...");
					if (!goal?.trim()) {
						ctx.ui.notify("ferment start cancelled — no goal provided", "info");
						return;
					}

					const ferment = createMinimalFerment(goal.trim(), ctx.cwd);
					store.save(ferment);
					setActive(ferment);
					// Default to manual policy — user can switch to auto via /ferment auto
					ctx.ui.notify(`🍺  Ferment "${ferment.name}" started. Scoping...`, "info");
					api.sendMessage(
						{
							content: `The ferment "${ferment.name}" has been created. You MUST now scope the work by calling \`ferment_scope\` with a complete plan.

Work through these steps in order:
1. ORIENT — Quickly scan the project: file listing, README, config files. Build an initial mental model.
2. IDENTIFY unknowns — What assumptions are you making? What could you be wrong about?
3. Define success criteria — What does "done" look like in specific, testable terms?
4. Define constraints — Known constraints, non-negotiables, technology choices.
5. Create phases — Break the work into logical phases. Each phase needs a name, goal, and concrete steps.

Then call \`ferment_scope\` with:
- goal: "${goal.trim()}"
- successCriteria: concrete, testable criteria for completion
- constraints: any non-negotiables or known limitations
- phases: array of { name, goal, steps: [{ description }] }

Call \`ferment_scope\` NOW. Do not explain — just call it with a complete plan.`,
							customType: "ferment_start",
							display: false,
						},
						{ triggerTurn: true },
					);
					break;
				}

				case "pause": {
					const f = getActive();
					if (!f) {
						ctx.ui.notify("No active ferment to pause.", "warning");
						return;
					}
					if (f.status === "paused") {
						ctx.ui.notify(`Ferment "${f.name}" is already paused.`, "info");
						return;
					}
					const result = applyTransition(f, { type: "pause" });
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return;
					}
					setActive(result);
					FermentStore.open().save(result);
					ctx.ui.notify(`Ferment "${result.name}" paused.`, "info");
					break;
				}

				case "resume": {
					const f = getActive();
					if (!f) {
						ctx.ui.notify("No active ferment to resume.", "warning");
						return;
					}
					if (f.status !== "paused") {
						ctx.ui.notify(`Ferment "${f.name}" is not paused (status: ${f.status}).`, "info");
						return;
					}
					const result = applyTransition(f, { type: "resume" });
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return;
					}
					setActive(result);
					FermentStore.open().save(result);

					const action = whatNext(result);
					const nudgeContent = action
						? `Ferment "${result.name}" resumed. Next action: ${action.kind}. ${action.message}`
						: `Ferment "${result.name}" resumed.`;
					api.sendMessage(
						{ content: nudgeContent, customType: "ferment_resume", display: false },
						{ triggerTurn: true },
					);
					break;
				}

				case "progress": {
					await showProgressOverlay(ctx, api);
					break;
				}

				case "abort": {
					const f = getActive();
					if (!f) {
						ctx.ui.notify("No active ferment to abort.", "warning");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						`Abandon ferment "${f.name}"?`,
						"This action cannot be undone. All progress will be lost.",
					);
					if (!confirmed) {
						ctx.ui.notify("Abort cancelled.", "info");
						return;
					}
					const reason = await ctx.ui.input("Reason for abandoning (optional)");
					const result = applyTransition(f, { type: "abandon", reason });
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return;
					}
					setActive(undefined);
					FermentStore.open().save(result);
					ctx.ui.notify(`Ferment "${result.name}" abandoned.`, "info");
					break;
				}

				case "policy": {
					const current = getContinuationPolicy();
					const next: "automated" | "manual" = current === "automated" ? "manual" : "automated";
					setContinuationPolicy(next);
					ctx.ui.notify(
						`Ferment continuation policy: ${next}${next === "automated" ? " (auto-nudge on turn end)" : " (manual only)"}`,
						"info",
					);
					break;
				}

				case "list": {
					const store = FermentStore.open();
					const ferments = store.listByWorktree(ctx.cwd);
					if (ferments.length === 0) {
						ctx.ui.notify("No ferments in this worktree.", "info");
						return;
					}
					const selected = await ctx.ui.select(
						"Ferments:",
						ferments.map(f => ({ label: `${f.name} (${f.status})`, description: f.goal ?? undefined })),
					);
					if (!selected) {
						ctx.ui.notify("ferment list cancelled", "info");
						return;
					}
					const picked = ferments.find(f => `${f.name} (${f.status})` === selected);
					if (picked) {
						setActive(picked);
						ctx.ui.notify(`Activated ferment "${picked.name}" (${picked.status}).`, "info");
					}
					break;
				}

				case "switch": {
					const query = args.slice(1).join(" ");
					if (!query) {
						ctx.ui.notify("Usage: /ferment switch <id|name>", "info");
						return;
					}
					const store = FermentStore.open();
					const ferments = store.listByWorktree(ctx.cwd);
					let found = ferments.find(f => f.id.startsWith(query));
					if (!found) {
						found = ferments.find(f => f.name.toLowerCase().includes(query.toLowerCase()));
					}
					if (found) {
						setActive(found);
						ctx.ui.notify(`Switched to ferment "${found.name}" (${found.status}).`, "info");
					} else {
						ctx.ui.notify(`No ferment matching '${query}'.`, "warning");
					}
					break;
				}

				case "delete": {
					const query = args.slice(1).join(" ");
					if (!query) {
						ctx.ui.notify("Usage: /ferment delete <id|name>", "info");
						return;
					}
					const store = FermentStore.open();
					const ferments = store.listByWorktree(ctx.cwd);
					let found = ferments.find(f => f.id.startsWith(query));
					if (!found) {
						found = ferments.find(f => f.name.toLowerCase().includes(query.toLowerCase()));
					}
					if (!found) {
						ctx.ui.notify(`No ferment matching '${query}'.`, "warning");
						return;
					}
					const confirmed = await ctx.ui.confirm(`Delete ferment "${found.name}"?`, "This cannot be undone.");
					if (!confirmed) {
						ctx.ui.notify("Delete cancelled.", "info");
						return;
					}
					const wasActive = getActive()?.id === found.id;
					store.delete(found.id);
					if (wasActive) {
						clearActive();
					}
					ctx.ui.notify(`Ferment "${found.name}" deleted.`, "info");
					break;
				}

				case "one-shot": {
					const goal = args.slice(1).join(" ");
					if (!goal) {
						ctx.ui.notify("Usage: /ferment one-shot <goal>", "info");
						return;
					}

					const draft = createMinimalFerment(goal, ctx.cwd);
					// Rename to "One-shot" for consistent display (hScope uses title ?? f.name)
					const namedDraft = { ...draft, name: "One-shot" };
					const result = applyTransition(namedDraft, {
						type: "oneShot",
						title: "One-shot",
						goal,
					});

					if ("error" in result) {
						ctx.ui.notify(`Failed to start one-shot ferment: ${result.error}`, "error");
						return;
					}

					const store = FermentStore.open();
					store.save(result);
					setActive(result);
					setContinuationPolicy("automated");
					ctx.ui.notify(`One-shot ferment started.`, "info");

					// Nudge the agent to execute the task inline
					api.sendMessage(
						{
							content: `You are running a one-shot ferment: "${result.name}" (ID: ${result.id}).
User intent: "${goal}"
Your task — execute the task autonomously. The ferment has been pre-configured with a single phase and step. Follow the ferment lifecycle tools to execute the step, then complete the phase and ferment when done.
Do not ask for confirmation or narrate progress. Execute until completion.`,
							customType: "ferment_one_shot",
							display: false,
						},
						{ triggerTurn: true },
					);
					break;
				}

				default:
					ctx.ui.notify(
						"/ferment start | pause | resume | progress | abort | policy | list | switch | delete | one-shot",
						"info",
					);
			}
		},
	});

	api.registerShortcut("f6", {
		description: "Toggle ferment continuation policy",
		handler: async ctx => {
			const current = getContinuationPolicy();
			const next: "automated" | "manual" = current === "automated" ? "manual" : "automated";
			setContinuationPolicy(next);
			ctx.ui.notify(`Ferment policy: ${next}`, "info");
		},
	});
}
