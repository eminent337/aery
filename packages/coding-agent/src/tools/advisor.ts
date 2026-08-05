import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import advisorDescription from "../prompts/tools/advisor.md" with { type: "text" };
import type { AdvisorToolState, ToolSession } from ".";
import { ToolError } from "./tool-errors";

const advisorSchema = z.object({
	action: z
		.enum(["enable", "disable", "status", "dump"])
		.optional()
		.describe('Action to perform. Defaults to "status".'),
	compact: z
		.boolean()
		.optional()
		.describe("For dump: render the advisor transcript in compact form (default false = full dump)."),
});

export type AdvisorToolParams = z.infer<typeof advisorSchema>;

/**
 * Manage and inspect the session's advisor (background advisory agent).
 *
 * Thin wrapper over AgentSession advisor APIs. Reports BOTH the configured
 * setting (`advisor.enabled`) and whether an advisor agent is actually running
 * (`isAdvisorActive`) — the runtime can be inactive even when the setting is on
 * (e.g. no model assigned to the advisor role, or not applicable to this agent
 * kind).
 */
export class AdvisorTool implements AgentTool<typeof advisorSchema, AdvisorToolState> {
	readonly name = "advisor";
	readonly approval = "read" as const;
	readonly label = "Advisor";
	readonly description = advisorDescription;
	readonly parameters = advisorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Enable, disable, or inspect the background advisor (status / transcript dump)";
	readonly intent = (args: Partial<AdvisorToolParams>) =>
		args.action ? `${args.action}ing advisor` : "checking advisor status";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_id: string,
		params: AdvisorToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AdvisorToolState>> {
		return untilAborted(signal, async () => {
			if (!this.session.getAdvisorState) {
				throw new ToolError("advisor is not available in this session.");
			}
			const action = params.action ?? "status";
			if (action === "enable" && this.session.setAdvisorEnabled) {
				this.session.setAdvisorEnabled(true);
			} else if (action === "disable" && this.session.setAdvisorEnabled) {
				this.session.setAdvisorEnabled(false);
			}

			const state = this.session.getAdvisorState({
				history: action === "dump",
				compact: params.compact,
			});
			if (!state) {
				throw new ToolError("Advisor state is unavailable.");
			}

			const lines: string[] = [];
			switch (action) {
				case "enable":
					lines.push("Advisor enabled.", state.status);
					break;
				case "disable":
					lines.push("Advisor disabled.", state.status);
					break;
				case "dump":
					lines.push(state.status);
					if (state.history) {
						lines.push("", "Advisor transcript:", state.history);
					} else {
						lines.push("No advisor transcript available (advisor is not active).");
					}
					break;
				default:
					lines.push(state.status);
					break;
			}
			if (!state.active && state.configured) {
				lines.push(
					"Note: advisor setting is enabled but no advisor agent is running (no model for the advisor role, or not applicable here).",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: state,
			};
		});
	}
}
