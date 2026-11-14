import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from ".";

const enterPlanModeSchema = z.object({
	focus: z
		.string()
		.optional()
		.describe("Optional description of the feature or architectural design to plan"),
});

export interface EnterPlanModeDetails {
	message: string;
	active: boolean;
	focus?: string;
}

export class EnterPlanModeTool implements AgentTool<typeof enterPlanModeSchema, EnterPlanModeDetails> {
	readonly loadMode = "discoverable";
	readonly name = "enter_plan_mode";
	readonly approval = "read";
	readonly label = "Enter Plan Mode";
	readonly description =
		"Enters plan mode for tasks requiring exploration and design. Enforces a read-only exploration phase until an implementation approach is finalized.";
	readonly summary = "Enter read-only exploration and plan mode";
	readonly parameters = enterPlanModeSchema;

	constructor(private session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof enterPlanModeSchema>,
	): Promise<AgentToolResult<EnterPlanModeDetails>> {
		if (this.session.getPlanModeState) {
			const state = this.session.getPlanModeState();
			state.enabled = true;
		}

		const focusNote = params.focus ? `\nFocus: ${params.focus}` : "";
		const message = `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.${focusNote}`;
		const instructions = `${message}\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase using read, grep, find, and semantic tools\n2. Identify similar patterns and existing architectural boundaries\n3. Consider multiple implementation approaches and their trade-offs\n4. Ask clarifying questions if multiple viable directions exist\n5. Formulate a step-by-step implementation strategy\n6. When ready, call exit_plan_mode with your full plan to present it for user review\n\nImportant: Do not write or edit production files yet. This is a read-only exploration and architecture design phase.`;

		return {
			content: [{ type: "text", text: instructions }],
			details: {
				message,
				active: true,
				focus: params.focus,
			},
		};
	}
}

const exitPlanModeSchema = z.object({
	plan: z.string().describe("The comprehensive implementation plan to propose for user approval"),
	title: z
		.string()
		.optional()
		.describe("Short title for the plan"),
});

export interface ExitPlanModeDetails {
	message: string;
	plan: string;
	planPath?: string;
	approved: boolean;
}

export class ExitPlanModeTool implements AgentTool<typeof exitPlanModeSchema, ExitPlanModeDetails> {
	readonly loadMode = "discoverable";
	readonly name = "exit_plan_mode";
	readonly approval = "read";
	readonly label = "Exit Plan Mode";
	readonly description =
		"Exits plan mode, submits the compiled implementation plan, and presents it for user review and consent.";
	readonly summary = "Submit implementation plan and exit plan mode";
	readonly parameters = exitPlanModeSchema;

	constructor(private session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof exitPlanModeSchema>,
	): Promise<AgentToolResult<ExitPlanModeDetails>> {
		if (this.session.getPlanModeState) {
			const state = this.session.getPlanModeState();
			state.enabled = false;
		}

		let planPath: string | undefined;
		try {
			const cwd = process.cwd();
			const targetDir = path.join(cwd, ".aery", "plans");
			await fs.mkdir(targetDir, { recursive: true });
			const safeTitle = (params.title || "implementation-plan").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
			planPath = path.join(targetDir, `${Date.now()}-${safeTitle}.md`);
			await fs.writeFile(planPath, params.plan, "utf-8");
		} catch {}

		const message = "Plan submitted successfully. Exited read-only plan mode.";
		const pathMsg = planPath ? `\nSaved plan copy: ${planPath}` : "";
		const outputText = `${message}${pathMsg}\n\nProposed Implementation Plan:\n<DO_NOT_COMPACT_THIS>\n${params.plan}\n</DO_NOT_COMPACT_THIS>\n\nPlease review the plan above. If approved, implementation will proceed.`;

		return {
			content: [{ type: "text", text: outputText }],
			details: {
				message,
				plan: params.plan,
				planPath,
				approved: true,
			},
		};
	}
}
