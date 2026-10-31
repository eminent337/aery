/**
 * InvokeSubagentTool — Ported from Google Antigravity (agy).
 *
 * Launches a named subagent (built-in or custom type) in the background.
 * Returns a conversationId the caller can use with send_message to communicate
 * with the running subagent.
 *
 * Built-in types: "self", "research", "image-generator"
 * Custom types can be defined via define_subagent (not yet wired — registry lookup only).
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { AgentRegistry } from "../registry/agent-registry";
import { getSubagentDefinition } from "../registry/builtin-subagents";
import { SubagentRunner } from "../registry/subagent-runner";
import type { ToolSession } from "./index";

const invokeSubagentSchema = z.object({
	TypeName: z
		.string()
		.describe(
			"Type name of the subagent to invoke. Built-in types: 'self', 'research', 'image-generator'. Use 'inherit' for a direct copy of the current agent.",
		),
	Role: z.string().describe("A 2–5 word description of the subagent's role (e.g. 'Codebase Researcher')."),
	Prompt: z.string().describe("A clear, actionable task description for the subagent."),
	Model: z
		.string()
		.optional()
		.describe("Model for the subagent. 'inherit' uses the parent model. 'flash' or 'pro' for lighter/heavier work."),
	Workspace: z
		.enum(["inherit", "branch", "share"])
		.optional()
		.describe(
			"Workspace mode. 'inherit' shares the parent workspace. 'branch' creates an isolated copy. 'share' shares the underlying repo without duplicating storage.",
		),
});

export type InvokeSubagentParams = z.infer<typeof invokeSubagentSchema>;

export class InvokeSubagentTool implements AgentTool<typeof invokeSubagentSchema> {
	readonly name = "invoke_subagent";
	readonly approval = "exec" as const;
	readonly label = "Invoke Subagent";
	readonly description =
		"Launch a subagent. It runs in the background and sends you a message when it completes. Returns a conversationId you can pass to send_message to communicate with it. Built-in types: 'self' (full parent capabilities), 'research' (read-only codebase explorer), 'image-generator' (visual asset creator).";
	readonly parameters = invokeSubagentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Subagent launcher matching agy invoke_subagent schema";

	private readonly runner: SubagentRunner;

	constructor(
		private readonly session?: ToolSession,
		runner?: SubagentRunner,
	) {
		this.runner = runner ?? new SubagentRunner(session?.agentRegistry ?? AgentRegistry.global());
	}

	static createIf(session: ToolSession, runner?: SubagentRunner): InvokeSubagentTool {
		return new InvokeSubagentTool(session, runner);
	}

	async execute(
		_toolCallId: string,
		params: InvokeSubagentParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const typeName = params.TypeName;
		const role = params.Role;
		const model = params.Model ?? "inherit";
		const workspace = params.Workspace ?? "inherit";

		const parentId = this.session?.getAgentId?.() ?? undefined;
		const cwd = this.session?.cwd;

		const launchResult = await this.runner.launch({
			TypeName: typeName,
			Role: role,
			Prompt: params.Prompt,
			Model: params.Model,
			Workspace: params.Workspace,
			parentId: parentId || undefined,
			cwd: cwd || undefined,
		});

		const subagentDef = getSubagentDefinition(typeName);
		const description = subagentDef?.description ?? `Custom subagent of type '${typeName}'`;

		const resultLines = [
			`Subagent launched successfully.`,
			``,
			`| Field | Value |`,
			`| :--- | :--- |`,
			`| **conversationId** | \`${launchResult.conversationId}\` |`,
			`| **TypeName** | ${typeName} |`,
			`| **Role** | ${role} |`,
			`| **Model** | ${model} |`,
			`| **Workspace** | ${workspace} |`,
			`| **Log** | \`${launchResult.logAbsoluteUri}\` |`,
			``,
			`**Description:** ${description}`,
			``,
			`Use \`send_message\` with \`Recipient: "${launchResult.conversationId}"\` to communicate with this subagent.`,
			`Use \`manage_subagents\` with \`Action: "list"\` to view all active subagents.`,
		];

		return {
			content: [{ type: "text", text: resultLines.join("\n") }],
			details: {
				conversationId: launchResult.conversationId,
				logAbsoluteUri: launchResult.logAbsoluteUri,
				workspaceUris: launchResult.workspaceUris,
				typeName,
				role,
				model,
				workspace,
				description,
			},
		};
	}
}
