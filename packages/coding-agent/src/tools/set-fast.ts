import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import setFastDescription from "../prompts/tools/set-fast.md" with { type: "text" };
import type { FastModeToolState, ToolSession } from ".";
import { ToolError } from "./tool-errors";

const setFastSchema = z.object({
	enabled: z.boolean().optional().describe("Whether to enable fast mode. Omit to report the current fast-mode state."),
});

export type SetFastToolParams = z.infer<typeof setFastSchema>;

/**
 * Enable/disable fast mode (priority service tier) or report its state.
 *
 * Thin wrapper over AgentSession fast-mode APIs. Reports BOTH the configured
 * setting (`isFastModeEnabled`) and whether fast mode is actually active for
 * the current model's provider (`isFastModeActive`) — the two can diverge
 * (e.g. the provider or model does not support the priority tier).
 */
export class SetFastTool implements AgentTool<typeof setFastSchema, FastModeToolState> {
	readonly name = "set_fast";
	readonly approval = "read" as const;
	readonly label = "Set Fast Mode";
	readonly description = setFastDescription;
	readonly parameters = setFastSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Enable or disable fast mode (priority service tier), or report fast-mode state";
	readonly intent = (args: Partial<SetFastToolParams>) =>
		args.enabled === undefined ? "checking fast mode" : args.enabled ? "enabling fast mode" : "disabling fast mode";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_id: string,
		params: SetFastToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FastModeToolState>> {
		return untilAborted(signal, async () => {
			if (!this.session.getFastModeState) {
				throw new ToolError("set_fast is not available in this session.");
			}
			if (params.enabled !== undefined && this.session.setFastMode) {
				this.session.setFastMode(params.enabled);
			}
			const state = this.session.getFastModeState();
			if (!state) {
				throw new ToolError("Fast-mode state is unavailable.");
			}

			const lines = [
				params.enabled === undefined
					? `Fast mode:\n  Enabled (setting): ${state.enabled ? "yes" : "no"}`
					: `Fast mode ${params.enabled ? "enabled" : "disabled"}.`,
				`  Active (current model/provider): ${state.active ? "yes" : "no"}`,
				`  Model: ${state.model ?? "unknown"}`,
				state.serviceTier ? `  Service tier: ${state.serviceTier}` : null,
			].filter((line): line is string => line !== null);

			if (params.enabled && !state.active) {
				lines.push(
					"Note: fast mode is configured but not active for the current model/provider (provider mismatch or unsupported model).",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: state,
			};
		});
	}
}
