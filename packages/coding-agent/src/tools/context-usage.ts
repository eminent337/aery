import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import contextDescription from "../prompts/tools/context.md" with { type: "text" };
import type { ToolSession } from ".";

const contextUsageSchema = z.object({});

export type ContextUsageParams = z.infer<typeof contextUsageSchema>;

/**
 * Report the current session's context usage (window size, used tokens, and
 * percent) so the agent can autonomously monitor its own context pressure and
 * decide whether to compact or trim before hitting the window.
 */
export class ContextUsageTool implements AgentTool<typeof contextUsageSchema> {
	readonly name = "context";
	readonly approval = "read" as const;
	readonly label = "Context";
	readonly description = contextDescription;
	readonly parameters = contextUsageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Report current context usage (tokens / window)";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, _params: ContextUsageParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const usage = this.session.getContextUsage?.();
			if (!usage || usage.contextWindow <= 0) {
				return {
					content: [
						{ type: "text", text: "Context usage is unavailable: no model is selected for this session." },
					],
					details: {},
				};
			}
			const usedLabel = usage.tokens === null ? "unknown" : `${usage.tokens.toLocaleString()} tokens`;
			const percentLabel = usage.percent === null ? "unknown" : `${Math.round(usage.percent)}% used`;
			const freeTokens = usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
			const freeLabel = freeTokens === null ? "unknown" : `${freeTokens.toLocaleString()} tokens free`;
			return {
				content: [
					{
						type: "text",
						text: [
							`Context window: ${usage.contextWindow.toLocaleString()} tokens`,
							`Used: ${usedLabel} (${percentLabel})`,
							`Free: ${freeLabel}`,
						].join("\n"),
					},
				],
				details: {},
			};
		});
	}
}
