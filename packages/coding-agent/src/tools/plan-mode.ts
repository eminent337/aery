import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from ".";

const enterPlanModeSchema = z.object({});

export class EnterPlanModeTool implements AgentTool<typeof enterPlanModeSchema, { message: string }> {
	readonly name = "enter_plan_mode";
	readonly approval = "read";
	readonly label = "Enter Plan Mode";
	readonly description = "Requests permission to enter plan mode for complex tasks requiring exploration and design";
	readonly parameters = enterPlanModeSchema;

	constructor(private session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: z.infer<typeof enterPlanModeSchema>,
	): Promise<AgentToolResult<{ message: string }>> {
		// Route plan-mode entry through live context transition helpers if available in session
		if (this.session.getPlanModeState) {
			// Stub implementation for plan mode entry
		}

		const message =
			"Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.";
		const instructions = `${message}\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase to understand existing patterns\n2. Identify similar features and architectural approaches\n3. Consider multiple approaches and their trade-offs\n4. Use ask/resolve if you need to clarify the approach\n5. Design a concrete implementation strategy\n6. When ready, use exit_plan_mode to present your plan for approval\n\nRemember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`;

		return {
			content: [{ type: "text", text: instructions }],
			details: { message },
		};
	}
}

const exitPlanModeSchema = z.object({
	plan: z.string().describe("The plan to propose and present to the user"),
});

export class ExitPlanModeTool implements AgentTool<typeof exitPlanModeSchema, { message: string }> {
	readonly name = "exit_plan_mode";
	readonly approval = "read";
	readonly label = "Exit Plan Mode";
	readonly description = "Exit plan mode and present the planned approach";
	readonly parameters = exitPlanModeSchema;

	async execute(
		_toolCallId: string,
		params: z.infer<typeof exitPlanModeSchema>,
	): Promise<AgentToolResult<{ message: string }>> {
		const message = "Exited plan mode.";
		return {
			content: [
				{
					type: "text",
					text: `${message}\n\nProposed Plan:\n<DO_NOT_COMPACT_THIS>\n${params.plan}\n</DO_NOT_COMPACT_THIS>`,
				},
			],
			details: { message },
		};
	}
}
