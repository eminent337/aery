import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import setModelDescription from "../prompts/tools/set-model.md" with { type: "text" };
import type { SetModelResult, ToolSession } from ".";
import { ToolError } from "./tool-errors";

const setModelSchema = z.object({
	model: z
		.string()
		.describe(
			"Model id, provider/id, or a role name (default, smol, slow, vision, plan, designer, commit, task, advisor, or a custom role) to switch to",
		),
	role: z.string().optional().describe("Optional role to persist the assignment under (settings.setModelRole)"),
	persist: z
		.boolean()
		.optional()
		.describe("Whether to persist the switch to settings (default false = session-scoped)"),
});

export type SetModelToolParams = z.infer<typeof setModelSchema>;

/**
 * Switch the active model for the current session.
 *
 * Thin wrapper over AgentSession.setModel / setModelTemporary: resolves the
 * requested model (by id, provider/id, or role name), validates it, and applies
 * the switch. Model switches take effect on the next turn — the existing
 * conversation context is preserved.
 */
export class SetModelTool implements AgentTool<typeof setModelSchema, SetModelResult> {
	readonly name = "set_model";
	readonly approval = "read" as const;
	readonly label = "Set Model";
	readonly description = setModelDescription;
	readonly parameters = setModelSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Switch the active model (by id, provider/id, or role), optionally persisting the assignment";
	readonly intent = (args: Partial<SetModelToolParams>) =>
		args.model ? `switching model to ${args.model}` : "switching model";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_id: string,
		params: SetModelToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SetModelResult>> {
		return untilAborted(signal, async () => {
			if (!this.session.setModel) {
				throw new ToolError("set_model is not available in this session.");
			}
			let result: SetModelResult;
			try {
				result = await this.session.setModel(params);
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
			const lines = [
				`Model switched to ${result.applied}.`,
				`Takes effect on the next turn (context preserved).`,
				result.role ? `Assigned to role "${result.role}".` : null,
				result.persisted ? "Assignment persisted to settings." : "Assignment is session-scoped (not persisted).",
			].filter((line): line is string => line !== null);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: result,
			};
		});
	}
}
