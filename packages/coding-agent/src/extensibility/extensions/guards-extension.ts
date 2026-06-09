/**
 * Defensive guards extension — hooks into the agent loop to detect
 * repeating patterns, excessive exploration, and budget retry abuse.
 *
 * Wired into the session via the extension runner's event system.
 * Guard messages are delivered as "steer" messages.
 */

import {
	type BudgetRetryBlock,
	createBudgetRetryBlockFromCompletion,
	shouldBlockBudgetRetry,
} from "../../guards/budget-retry-guard.js";
import { ExplorationGuard } from "../../guards/exploration-guard.js";
import { LoopGuard } from "../../guards/loop-guard.js";
import type {
	ExtensionAPI,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./types.js";

interface GuardsExtensionOptions {
	loopGuard?: {
		enabled?: boolean;
		consecutiveThreshold?: number;
		ngramSize?: number;
		ngramThreshold?: number;
	};
	explorationGuard?: {
		enabled?: boolean;
		hypothesisThreshold?: number;
		steerThreshold?: number;
	};
	budgetRetryGuard?: {
		enabled?: boolean;
	};
}

/**
 * Create the guards extension factory. Returns a function suitable for
 * the inline extensions array in createAgentSession().
 */
export function createGuardsExtension(options?: GuardsExtensionOptions) {
	return function guardsExtension(api: ExtensionAPI): void {
		const loopGuard = options?.loopGuard?.enabled !== false ? new LoopGuard(options?.loopGuard) : null;
		const explorationGuard =
			options?.explorationGuard?.enabled !== false ? new ExplorationGuard(options?.explorationGuard) : null;
		const budgetRetryGuardEnabled = options?.budgetRetryGuard?.enabled !== false;
		const budgetRetryBlocks = new Map<string, BudgetRetryBlock>();
		const toolCallArgs = new Map<string, unknown>();

		api.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
			// Remember args so loop guard can see them on tool_execution_end
			toolCallArgs.set(event.toolCallId, event.args);

			// --- Budget retry guard: block retries with higher budgets ---
			if (!budgetRetryGuardEnabled) return;
			if (event.toolName !== "task" && event.toolName !== "invoke_subagent") return;
			if (budgetRetryBlocks.size === 0) return;

			const args = event.args as Record<string, unknown> | undefined;
			const attempt: import("../../guards/budget-retry-guard.js").BudgetRetryAttempt = {
				tokenBudget: typeof args?.tokenBudget === "number" ? args.tokenBudget : undefined,
				subagentType: event.toolName,
				description: typeof args?.description === "string" ? args.description : undefined,
				prompt: typeof args?.prompt === "string" ? args.prompt : undefined,
			};

			for (const block of budgetRetryBlocks.values()) {
				if (shouldBlockBudgetRetry(block, attempt)) {
					// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
					throw new Error(
						`Budget retry guard: blocked retry of ${event.toolName} ` +
							`with higher budget (${attempt.tokenBudget}) after previous exhaustion at ${block.budget} tokens.`,
					);
				}
			}
		});

		api.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
			const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {});
			const args = toolCallArgs.get(event.toolCallId) ?? {};
			toolCallArgs.delete(event.toolCallId);

			// --- Loop guard ---
			if (loopGuard) {
				const loopResult = loopGuard.record(event.toolName, args, event.isError, output);
				if (loopResult.state === "warn" || loopResult.state === "terminate") {
					api.sendMessage(
						{
							customType: "loop-guard-steer",
							content: [{ type: "text", text: loopResult.reason! }],
							display: false,
						},
						{ deliverAs: "steer" },
					);
				}
			}

			// --- Exploration guard: record tool call for current turn ---
			if (explorationGuard) {
				explorationGuard.recordToolCall(event.toolName);
			}

			// --- Budget retry guard: record exhaustion for subagent tools ---
			if (
				budgetRetryGuardEnabled &&
				(event.toolName === "task" || event.toolName === "invoke_subagent") &&
				event.isError
			) {
				const outputText = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
				const isBudgetAbort = outputText.includes("token_budget") || outputText.includes("exceeded");
				if (isBudgetAbort) {
					const block = createBudgetRetryBlockFromCompletion(
						{
							budget: 0,
							subagentType: event.toolName,
							description: event.toolName,
							prompt: outputText.slice(0, 200),
						},
						{ status: "aborted", abortReason: "token_budget" },
					);
					if (block) {
						budgetRetryBlocks.set(event.toolCallId, block);
					}
				}
			}
		});

		api.on("turn_end", (_event: TurnEndEvent) => {
			if (!explorationGuard) return;
			explorationGuard.turnEnd(text => {
				api.sendMessage(
					{
						customType: "exploration-guard-steer",
						content: [{ type: "text", text }],
						display: false,
					},
					{ deliverAs: "steer" },
				);
			});
		});

		api.on("turn_start", (_event: TurnStartEvent) => {
			if (!explorationGuard) return;
			explorationGuard.turnStart();
		});

		api.on("session_start", () => {
			if (loopGuard) loopGuard.reset();
			if (explorationGuard) explorationGuard.reset();
			budgetRetryBlocks.clear();
			toolCallArgs.clear();
		});
	};
}
