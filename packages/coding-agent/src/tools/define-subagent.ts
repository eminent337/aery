/**
 * DefineSubagentTool — Ported from Google Antigravity (agy).
 *
 * Defines a new subagent type that can then be invoked repeatedly via invoke_subagent.
 * Subagents always have tools to research the codebase and to communicate with other agents.
 *
 * Schema matching agy:
 * - Name: unique type name used to invoke the subagent
 * - Description: what this subagent does and when it should be used
 * - SystemPrompt: system prompt for the subagent
 * - EnableWriteTools: grant tools to create and edit files, and run commands
 * - EnableSubagentTools: grant tools to define and invoke its own subagents
 * - EnableMCPTools: grant access to MCP tools
 */

import * as z from "zod/v4";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import { defineCustomSubagent, type CustomSubagentDefinition } from "../registry/builtin-subagents";
import type { ToolSession } from "./index";

const defineSubagentSchema = z.object({
	Name: z.string().optional().describe("Unique name used to invoke the subagent."),
	Description: z.string().optional().describe("What this subagent does and when it should be used."),
	SystemPrompt: z.string().optional().describe("System prompt for the subagent."),
	EnableWriteTools: z
		.boolean()
		.optional()
		.describe("Grant tools to create and edit files, and run commands (write_file, edit_file, run_command, bash)."),
	EnableSubagentTools: z
		.boolean()
		.optional()
		.describe("Grant tools to define and invoke its own subagents (invoke_subagent, define_subagent, manage_subagents)."),
	EnableMCPTools: z.boolean().optional().describe("Grant access to MCP tools."),
	// Lowercase aliases for interoperability
	name: z.string().optional().describe("Subagent name (lowercase alias)."),
	description: z.string().optional().describe("Subagent description (lowercase alias)."),
	systemPrompt: z.string().optional().describe("Subagent system prompt (lowercase alias)."),
	enableWriteTools: z.boolean().optional().describe("Grant write tools (lowercase alias)."),
	enableSubagentTools: z.boolean().optional().describe("Grant subagent tools (lowercase alias)."),
	enableMCPTools: z.boolean().optional().describe("Grant MCP tools (lowercase alias)."),
});

export type DefineSubagentParams = z.infer<typeof defineSubagentSchema>;

export class DefineSubagentTool implements AgentTool<typeof defineSubagentSchema> {
	readonly name = "define_subagent";
	readonly approval = "read" as const;
	readonly label = "Define Subagent";
	readonly description =
		"Define a new subagent type that can then be invoked repeatedly. Subagents always have tools to research the codebase and to communicate with other agents.";
	readonly parameters = defineSubagentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Define a reusable custom subagent type matching agy schema";

	constructor(private readonly session?: ToolSession) {}

	static createIf(session: ToolSession): DefineSubagentTool {
		return new DefineSubagentTool(session);
	}

	async execute(
		_toolCallId: string,
		params: DefineSubagentParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const name = params.Name ?? params.name;
		const description = params.Description ?? params.description;
		const systemPrompt = params.SystemPrompt ?? params.systemPrompt;
		const enableWriteTools = params.EnableWriteTools ?? params.enableWriteTools ?? false;
		const enableSubagentTools = params.EnableSubagentTools ?? params.enableSubagentTools ?? false;
		const enableMCPTools = params.EnableMCPTools ?? params.enableMCPTools ?? false;

		if (!name || !name.trim()) {
			return {
				content: [{ type: "text", text: "Error: Name is required to define a subagent." }],
				isError: true,
			};
		}
		if (!description || !description.trim()) {
			return {
				content: [{ type: "text", text: "Error: Description is required to define a subagent." }],
				isError: true,
			};
		}
		if (!systemPrompt || !systemPrompt.trim()) {
			return {
				content: [{ type: "text", text: "Error: SystemPrompt is required to define a subagent." }],
				isError: true,
			};
		}

		const cleanName = name.trim();
		const registered = defineCustomSubagent({
			name: cleanName,
			description: description.trim(),
			systemPrompt: systemPrompt.trim(),
			enableWriteTools,
			enableSubagentTools,
			enableMCPTools,
		});

		const grantedCapabilities: string[] = ["Research (read_file, search_web, find_by_name, grep_search, list_dir)"];
		if (enableWriteTools) grantedCapabilities.push("File Writes & Commands (write_file, edit_file, run_command, bash)");
		if (enableSubagentTools) grantedCapabilities.push("Recursive Subagents (invoke_subagent, define_subagent, manage_subagents)");
		if (enableMCPTools) grantedCapabilities.push("MCP Tools (call_mcp_tool, list_resources, read_resource)");

		const resultLines = [
			`### Subagent Type Defined: \`${cleanName}\``,
			``,
			`| Property | Value |`,
			`| :--- | :--- |`,
			`| **Name** | \`${cleanName}\` |`,
			`| **Description** | ${description.trim()} |`,
			`| **Write Tools** | ${enableWriteTools ? "Enabled" : "Disabled"} |`,
			`| **Subagent Tools** | ${enableSubagentTools ? "Enabled" : "Disabled"} |`,
			`| **MCP Tools** | ${enableMCPTools ? "Enabled" : "Disabled"} |`,
			``,
			`**Capabilities Granted:**`,
			...grantedCapabilities.map(c => `- ${c}`),
			``,
			`This subagent can now be invoked via \`invoke_subagent\` with \`TypeName: "${cleanName}"\`.`,
		];

		return {
			content: [{ type: "text", text: resultLines.join("\n") }],
			details: {
				subagent: registered,
				capabilities: grantedCapabilities,
			},
		};
	}
}
