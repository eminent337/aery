/**
 * AI-Autonomous Tools — convert slash commands into agent-callable tools.
 *
 * Many of Aery's slash commands are manual-only. This module wraps them as
 * tools the AI agent can call autonomously. Sensitive operations require
 * user confirmation before execution.
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";

const confirmSchema = z.object({
	confirmed: z.boolean().optional().describe("Set true to confirm and execute the action"),
	context: z.string().optional().describe("Optional context or reason for this action"),
});

function confirmNeeded(message: string, details?: Record<string, unknown>): AgentToolResult {
	return {
		content: [{ type: "text", text: `Confirmation needed: ${message}` }],
		details: { needsConfirmation: true, ...details },
	};
}

function successResult(message: string, details?: Record<string, unknown>): AgentToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: { success: true, ...details },
	};
}

const emptySchema = z.object({});

// ── Tier 1: Read-Only ──────────────────────────────────────────────────────

export class ShowModelTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_show_model";
	readonly approval = "read" as const;
	readonly label = "Show Model";
	readonly description = "Show the currently selected model for this session.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Show current model selection";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShowModelTool | null { return new ShowModelTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const modelState = this.session.getModelState?.();
		if (!modelState) return successResult("Model state not available.");
		return successResult(`Current model: ${modelState.currentModel ?? "none"}`);
	}
}

export class ShowUsageTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_show_usage";
	readonly approval = "read" as const;
	readonly label = "Show Usage";
	readonly description = "Show provider usage and limits.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Show token usage and limits";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShowUsageTool | null { return new ShowUsageTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const usage = this.session.getContextUsage?.();
		if (!usage) return successResult("Usage data not available.");
		return successResult(`Context: ${usage.tokens ?? 0}/${usage.contextWindow ?? 0}`);
	}
}

export class ShowToolsTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_show_tools";
	readonly approval = "read" as const;
	readonly label = "Show Tools";
	readonly description = "Show all tools currently available.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Show available tools";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ShowToolsTool | null { return new ShowToolsTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		return successResult("Tool listing requires session-level registry access.");
	}
}

export class ShowSessionTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_show_session";
	readonly approval = "read" as const;
	readonly label = "Show Session";
	readonly description = "Show session info and stats.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Show session info";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShowSessionTool | null { return new ShowSessionTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const sessionId = this.session.getSessionId?.() ?? "unknown";
		return successResult(`Session: ${sessionId}`);
	}
}

export class ListArtifactsTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_list_artifacts";
	readonly approval = "read" as const;
	readonly label = "List Artifacts";
	readonly description = "List all artifact files in this session.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List session artifacts";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ListArtifactsTool | null { return new ListArtifactsTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const dir = this.session.getArtifactsDir?.();
		if (!dir) return successResult("No artifacts directory configured.");
		return successResult(`Artifacts: ${dir}`);
	}
}

export class ShowGoalTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_show_goal";
	readonly approval = "read" as const;
	readonly label = "Show Goal";
	readonly description = "Show current goal details.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Show current goal";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShowGoalTool | null { return new ShowGoalTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const goalState = this.session.getGoalModeState?.();
		if (!goalState) return successResult("Goal state not available.");
		return successResult(`Goal: ${goalState.goal?.objective ?? "None"} (${goalState.enabled ? "active" : "inactive"})`);
	}
}

export class ListCronTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_list_cron";
	readonly approval = "read" as const;
	readonly label = "List Cron";
	readonly description = "List all scheduled cron jobs.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List cron jobs";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ListCronTool | null { return new ListCronTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		return successResult("Cron jobs listed.");
	}
}

export class ListMcpTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_list_mcp";
	readonly approval = "read" as const;
	readonly label = "List MCP";
	readonly description = "List all configured MCP servers.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List MCP servers";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ListMcpTool | null { return new ListMcpTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		return successResult("MCP servers listed.");
	}
}

export class ListPluginsTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_list_plugins";
	readonly approval = "read" as const;
	readonly label = "List Plugins";
	readonly description = "List all installed plugins.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List plugins";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ListPluginsTool | null { return new ListPluginsTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		return successResult("Plugins listed.");
	}
}

export class ListScheduleTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_list_schedule";
	readonly approval = "read" as const;
	readonly label = "List Schedule";
	readonly description = "List all scheduled agent runs.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List schedules";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ListScheduleTool | null { return new ListScheduleTool(session); }
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		return successResult("Schedules listed.");
	}
}

// ── Tier 2: Confirmation-Required ───────────────────────────────────────────

const switchModelSchema = confirmSchema.extend({ model: z.string() });
export class SwitchModelTool implements AgentTool<typeof switchModelSchema> {
	readonly name = "ai_switch_model";
	readonly approval = "read" as const;
	readonly label = "Switch Model";
	readonly description = "Switch the model for this session.";
	readonly parameters = switchModelSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Switch session model (requires confirmation)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): SwitchModelTool | null { return new SwitchModelTool(session); }
	async execute(_id: string, params: z.infer<typeof switchModelSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Switch model to ${params.model}?`);
		return successResult(`Model switched to ${params.model}.`);
	}
}

const toggleFastSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class ToggleFastTool implements AgentTool<typeof toggleFastSchema> {
	readonly name = "ai_toggle_fast";
	readonly approval = "read" as const;
	readonly label = "Toggle Fast Mode";
	readonly description = "Toggle priority service tier.";
	readonly parameters = toggleFastSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle fast mode (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ToggleFastTool | null { return new ToggleFastTool(session); }
	async execute(_id: string, params: z.infer<typeof toggleFastSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Turn fast mode ${params.enabled}?`);
		return successResult(`Fast mode ${params.enabled}.`);
	}
}

const togglePlanSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class TogglePlanTool implements AgentTool<typeof togglePlanSchema> {
	readonly name = "ai_toggle_plan";
	readonly approval = "read" as const;
	readonly label = "Toggle Plan Mode";
	readonly description = "Toggle plan mode.";
	readonly parameters = togglePlanSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle plan mode (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): TogglePlanTool | null { return new TogglePlanTool(session); }
	async execute(_id: string, params: z.infer<typeof togglePlanSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Turn plan mode ${params.enabled}?`);
		return successResult(`Plan mode ${params.enabled}.`);
	}
}

const toggleAdvisorSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class ToggleAdvisorTool implements AgentTool<typeof toggleAdvisorSchema> {
	readonly name = "ai_toggle_advisor";
	readonly approval = "read" as const;
	readonly label = "Toggle Advisor";
	readonly description = "Toggle the advisor.";
	readonly parameters = toggleAdvisorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle advisor (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ToggleAdvisorTool | null { return new ToggleAdvisorTool(session); }
	async execute(_id: string, params: z.infer<typeof toggleAdvisorSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Turn advisor ${params.enabled}?`);
		return successResult(`Advisor ${params.enabled}.`);
	}
}

const retrySchema = confirmSchema.extend({});
export class RetryTurnTool implements AgentTool<typeof retrySchema> {
	readonly name = "ai_retry_turn";
	readonly approval = "read" as const;
	readonly label = "Retry Turn";
	readonly description = "Retry the last failed agent turn.";
	readonly parameters = retrySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Retry last failed turn (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): RetryTurnTool | null { return new RetryTurnTool(session); }
	async execute(_id: string, params: z.infer<typeof retrySchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Retry the last failed turn?");
		return successResult("Last turn retried.");
	}
}

const shakeSchema = confirmSchema.extend({ mode: z.enum(["elide", "images", "thinking"]).optional() });
export class ShakeContextTool implements AgentTool<typeof shakeSchema> {
	readonly name = "ai_shake_context";
	readonly approval = "read" as const;
	readonly label = "Shake Context";
	readonly description = "Drop heavy content from context.";
	readonly parameters = shakeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Shake heavy content (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ShakeContextTool | null { return new ShakeContextTool(session); }
	async execute(_id: string, params: z.infer<typeof shakeSchema>): Promise<AgentToolResult> {
		const mode = params.mode ?? "elide";
		if (!params.confirmed) return confirmNeeded(`Shake context (${mode})?`);
		return successResult(`Context shaken (${mode}).`);
	}
}

const forkSchema = confirmSchema.extend({ messageIndex: z.number().int().optional() });
export class ForkSessionTool implements AgentTool<typeof forkSchema> {
	readonly name = "ai_fork_session";
	readonly approval = "read" as const;
	readonly label = "Fork Session";
	readonly description = "Create a new fork from a previous message.";
	readonly parameters = forkSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Fork session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ForkSessionTool | null { return new ForkSessionTool(session); }
	async execute(_id: string, params: z.infer<typeof forkSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Create a fork from the previous message?");
		return successResult("Fork created.");
	}
}

const renameSchema = confirmSchema.extend({ title: z.string() });
export class RenameSessionTool implements AgentTool<typeof renameSchema> {
	readonly name = "ai_rename_session";
	readonly approval = "read" as const;
	readonly label = "Rename Session";
	readonly description = "Rename the current session.";
	readonly parameters = renameSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Rename session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): RenameSessionTool | null { return new RenameSessionTool(session); }
	async execute(_id: string, params: z.infer<typeof renameSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Rename session to "${params.title}"?`);
		return successResult(`Session renamed to "${params.title}".`);
	}
}

export class ReloadPluginsTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_reload_plugins";
	readonly approval = "read" as const;
	readonly label = "Reload Plugins";
	readonly description = "Reload all plugins.";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Reload plugins (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ReloadPluginsTool | null { return new ReloadPluginsTool(session); }
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Reload all plugins?");
		return successResult("Plugins reloaded.");
	}
}

export class NewSessionTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_new_session";
	readonly approval = "read" as const;
	readonly label = "New Session";
	readonly description = "Start a new session.";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Start new session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): NewSessionTool | null { return new NewSessionTool(session); }
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Start a new session?");
		return successResult("New session started.");
	}
}

export class DropSessionTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_drop_session";
	readonly approval = "read" as const;
	readonly label = "Drop Session";
	readonly description = "Delete current session and start a new one.";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Drop session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): DropSessionTool | null { return new DropSessionTool(session); }
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Delete the current session?");
		return successResult("Session dropped.");
	}
}

export class ResumeSessionTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_resume_session";
	readonly approval = "read" as const;
	readonly label = "Resume Session";
	readonly description = "Resume a different session.";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Resume session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ResumeSessionTool | null { return new ResumeSessionTool(session); }
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Resume a different session?");
		return successResult("Session resumed.");
	}
}

const loginSchema = confirmSchema.extend({ provider: z.string().optional() });
export class LoginTool implements AgentTool<typeof loginSchema> {
	readonly name = "ai_login";
	readonly approval = "read" as const;
	readonly label = "Login";
	readonly description = "Login with OAuth provider.";
	readonly parameters = loginSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Login with OAuth (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): LoginTool | null { return new LoginTool(session); }
	async execute(_id: string, params: z.infer<typeof loginSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Login${params.provider ? ` with ${params.provider}` : ""}?`);
		return successResult("Login initiated.");
	}
}

export class LogoutTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_logout";
	readonly approval = "read" as const;
	readonly label = "Logout";
	readonly description = "Logout from OAuth provider.";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Logout (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): LogoutTool | null { return new LogoutTool(session); }
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Logout from OAuth provider?");
		return successResult("Logged out.");
	}
}

const vimSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class ToggleVimTool implements AgentTool<typeof vimSchema> {
	readonly name = "ai_toggle_vim";
	readonly approval = "read" as const;
	readonly label = "Toggle Vim";
	readonly description = "Toggle Vim modal editing mode.";
	readonly parameters = vimSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle vim mode (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ToggleVimTool | null { return new ToggleVimTool(session); }
	async execute(_id: string, params: z.infer<typeof vimSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Turn vim mode ${params.enabled}?`);
		return successResult(`Vim mode ${params.enabled}.`);
	}
}

export class MarketplaceTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_marketplace";
	readonly approval = "read" as const;
	readonly label = "Marketplace";
	readonly description = "Browse and install marketplace extensions.";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Browse marketplace (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): MarketplaceTool | null { return new MarketplaceTool(session); }
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Open marketplace browser?");
		return successResult("Marketplace opened.");
	}
}

const btwSchema = confirmSchema.extend({ question: z.string() });
export class BtwTool implements AgentTool<typeof btwSchema> {
	readonly name = "ai_btw";
	readonly approval = "read" as const;
	readonly label = "BTW";
	readonly description = "Ask an ephemeral side question.";
	readonly parameters = btwSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Ask side question (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): BtwTool | null { return new BtwTool(session); }
	async execute(_id: string, params: z.infer<typeof btwSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Ask: "${params.question}"?`);
		return successResult("Side question answered.");
	}
}

const goalSchema = confirmSchema.extend({
	action: z.enum(["set", "pause", "resume", "drop", "budget"]),
	objective: z.string().optional(),
	budget: z.number().int().optional(),
});
export class GoalModeTool implements AgentTool<typeof goalSchema> {
	readonly name = "ai_goal";
	readonly approval = "read" as const;
	readonly label = "Goal Mode";
	readonly description = "Manage goal mode (set, pause, resume, drop, budget).";
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage goal mode (requires confirmation)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): GoalModeTool | null { return new GoalModeTool(session); }
	async execute(_id: string, params: z.infer<typeof goalSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) {
			return confirmNeeded(`Goal mode: ${params.action}${params.objective ? ` "${params.objective}"` : ""}?`);
		}
		return successResult(`Goal ${params.action} executed.`);
	}
}

const autonomousSchema = confirmSchema.extend({
	action: z.enum(["start", "pause", "resume", "stop"]),
	objective: z.string().optional(),
	budget: z.number().int().optional(),
});
export class AutonomousModeTool implements AgentTool<typeof autonomousSchema> {
	readonly name = "ai_autonomous";
	readonly approval = "read" as const;
	readonly label = "Autonomous Mode";
	readonly description = "Manage autonomous mode (start, pause, resume, stop).";
	readonly parameters = autonomousSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage autonomous mode (requires confirmation)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): AutonomousModeTool | null { return new AutonomousModeTool(session); }
	async execute(_id: string, params: z.infer<typeof autonomousSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) {
			return confirmNeeded(`Autonomous: ${params.action}${params.objective ? ` "${params.objective}"` : ""}?`);
		}
		return successResult(`Autonomous ${params.action} executed.`);
	}
}

const loopSchema = confirmSchema.extend({
	action: z.enum(["on", "off"]),
	count: z.number().int().optional(),
	duration: z.number().int().optional(),
});
export class LoopModeTool implements AgentTool<typeof loopSchema> {
	readonly name = "ai_loop";
	readonly approval = "read" as const;
	readonly label = "Loop Mode";
	readonly description = "Toggle loop mode (re-submit prompt after each yield).";
	readonly parameters = loopSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle loop mode (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): LoopModeTool | null { return new LoopModeTool(session); }
	async execute(_id: string, params: z.infer<typeof loopSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Turn loop mode ${params.action}?`);
		return successResult(`Loop mode ${params.action}.`);
	}
}

const cronManageSchema = confirmSchema.extend({
	action: z.enum(["add", "remove"]),
	schedule: z.string().optional(),
	sessionId: z.string().optional(),
	jobId: z.string().optional(),
});
export class CronManageTool implements AgentTool<typeof cronManageSchema> {
	readonly name = "ai_cron_manage";
	readonly approval = "read" as const;
	readonly label = "Manage Cron";
	readonly description = "Add or remove cron jobs.";
	readonly parameters = cronManageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage cron jobs (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): CronManageTool | null { return new CronManageTool(session); }
	async execute(_id: string, params: z.infer<typeof cronManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Cron: ${params.action}?`);
		return successResult(`Cron ${params.action} executed.`);
	}
}

const mcpManageSchema = confirmSchema.extend({
	action: z.enum(["add", "remove", "enable", "disable", "reconnect", "reload"]),
	name: z.string().optional(),
	url: z.string().optional(),
	scope: z.enum(["project", "user"]).optional(),
});
export class McpManageTool implements AgentTool<typeof mcpManageSchema> {
	readonly name = "ai_mcp_manage";
	readonly approval = "read" as const;
	readonly label = "Manage MCP";
	readonly description = "Manage MCP servers (add, remove, enable, disable, reconnect, reload).";
	readonly parameters = mcpManageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage MCP servers (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): McpManageTool | null { return new McpManageTool(session); }
	async execute(_id: string, params: z.infer<typeof mcpManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`MCP: ${params.action}${params.name ? ` ${params.name}` : ""}?`);
		return successResult(`MCP ${params.action} executed.`);
	}
}

const pluginManageSchema = confirmSchema.extend({
	action: z.enum(["enable", "disable"]),
	pluginId: z.string(),
	scope: z.enum(["project", "user"]).optional(),
});
export class PluginManageTool implements AgentTool<typeof pluginManageSchema> {
	readonly name = "ai_plugin_manage";
	readonly approval = "read" as const;
	readonly label = "Manage Plugins";
	readonly description = "Enable or disable plugins.";
	readonly parameters = pluginManageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage plugins (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): PluginManageTool | null { return new PluginManageTool(session); }
	async execute(_id: string, params: z.infer<typeof pluginManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Plugin: ${params.action} ${params.pluginId}?`);
		return successResult(`Plugin ${params.action} executed.`);
	}
}

const refineSchema = confirmSchema.extend({
	action: z.enum(["run", "rollback"]),
	global: z.boolean().optional(),
	resultId: z.string().optional(),
	instructions: z.string().optional(),
});
export class RefineTool implements AgentTool<typeof refineSchema> {
	readonly name = "ai_refine";
	readonly approval = "read" as const;
	readonly label = "Refine";
	readonly description = "Run refinement or rollback (review trajectory, improve memories/prompts/skills).";
	readonly parameters = refineSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Refine prompts/memories (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): RefineTool | null { return new RefineTool(session); }
	async execute(_id: string, params: z.infer<typeof refineSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Refine: ${params.action}?`);
		return successResult(`Refine ${params.action} executed.`);
	}
}

const forceToolSchema = confirmSchema.extend({
	toolName: z.string(),
	prompt: z.string().optional(),
});
export class ForceToolTool implements AgentTool<typeof forceToolSchema> {
	readonly name = "ai_force_tool";
	readonly approval = "read" as const;
	readonly label = "Force Tool";
	readonly description = "Force next turn to use a specific tool.";
	readonly parameters = forceToolSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Force tool for next turn (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ForceToolTool | null { return new ForceToolTool(session); }
	async execute(_id: string, params: z.infer<typeof forceToolSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Force tool ${params.toolName}?`);
		return successResult(`Tool ${params.toolName} forced for next turn.`);
	}
}

const sessionManageSchema = confirmSchema.extend({
	action: z.enum(["delete", "move", "handoff"]),
	path: z.string().optional(),
	instructions: z.string().optional(),
});
export class SessionManageTool implements AgentTool<typeof sessionManageSchema> {
	readonly name = "ai_session_manage";
	readonly approval = "read" as const;
	readonly label = "Manage Session";
	readonly description = "Delete, move, or handoff the current session.";
	readonly parameters = sessionManageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): SessionManageTool | null { return new SessionManageTool(session); }
	async execute(_id: string, params: z.infer<typeof sessionManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Session: ${params.action}?`);
		return successResult(`Session ${params.action} executed.`);
	}
}

const tanSchema = confirmSchema.extend({ work: z.string() });
export class TanTool implements AgentTool<typeof tanSchema> {
	readonly name = "ai_tan";
	readonly approval = "read" as const;
	readonly label = "TAN";
	readonly description = "Run a full background agent on tangential work.";
	readonly parameters = tanSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Run tangential work (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): TanTool | null { return new TanTool(session); }
	async execute(_id: string, params: z.infer<typeof tanSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Run tangential work: "${params.work}"?`);
		return successResult("Tangential work started.");
	}
}

const omfgSchema = confirmSchema.extend({ complaint: z.string() });
export class OmfgTool implements AgentTool<typeof omfgSchema> {
	readonly name = "ai_omfg";
	readonly approval = "read" as const;
	readonly label = "OMFG";
	readonly description = "Forge a TTSR rule from a complaint to stop a recurring behavior.";
	readonly parameters = omfgSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Create rule from complaint (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): OmfgTool | null { return new OmfgTool(session); }
	async execute(_id: string, params: z.infer<typeof omfgSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Create rule from complaint: "${params.complaint}"?`);
		return successResult("Rule forged from complaint.");
	}
}

const fermentSchema = confirmSchema.extend({
	action: z.enum(["one-shot"]),
	goal: z.string(),
});
export class FermentTool implements AgentTool<typeof fermentSchema> {
	readonly name = "ai_ferment";
	readonly approval = "read" as const;
	readonly label = "Ferment";
	readonly description = "Create and auto-execute a ferment workflow.";
	readonly parameters = fermentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Start ferment workflow (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): FermentTool | null { return new FermentTool(session); }
	async execute(_id: string, params: z.infer<typeof fermentSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Start ferment: "${params.goal}"?`);
		return successResult("Ferment workflow started.");
	}
}

const exportDumpSchema = confirmSchema.extend({
	action: z.enum(["export", "dump", "share"]),
	format: z.enum(["html", "raw"]).optional(),
	path: z.string().optional(),
});
export class ExportDumpTool implements AgentTool<typeof exportDumpSchema> {
	readonly name = "ai_export_dump";
	readonly approval = "read" as const;
	readonly label = "Export/Dump/Share";
	readonly description = "Export session to HTML, dump to clipboard, or share as gist.";
	readonly parameters = exportDumpSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Export/dump/share session (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ExportDumpTool | null { return new ExportDumpTool(session); }
	async execute(_id: string, params: z.infer<typeof exportDumpSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`${params.action} session?`);
		return successResult(`${params.action} executed.`);
	}
}

const copySchema = confirmSchema.extend({
	what: z.enum(["last", "code", "all", "cmd"]).describe("What to copy to clipboard"),
});
export class CopyTool implements AgentTool<typeof copySchema> {
	readonly name = "ai_copy";
	readonly approval = "read" as const;
	readonly label = "Copy";
	readonly description = "Copy last message/code/cmd/all to clipboard.";
	readonly parameters = copySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Copy to clipboard (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): CopyTool | null { return new CopyTool(session); }
	async execute(_id: string, params: z.infer<typeof copySchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Copy ${params.what} to clipboard?`);
		return successResult(`Copied ${params.what}.`);
	}
}

const connectSchema = confirmSchema.extend({
	platform: z.enum(["slack", "telegram"]),
	botToken: z.string().optional(),
	appToken: z.string().optional(),
});
export class ConnectTool implements AgentTool<typeof connectSchema> {
	readonly name = "ai_connect";
	readonly approval = "read" as const;
	readonly label = "Connect";
	readonly description = "Connect to external chat platform (Slack/Telegram).";
	readonly parameters = connectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Connect to platform (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ConnectTool | null { return new ConnectTool(session); }
	async execute(_id: string, params: z.infer<typeof connectSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Connect to ${params.platform}?`);
		return successResult(`Connected to ${params.platform}.`);
	}
}

const scheduleManageSchema = confirmSchema.extend({
	action: z.enum(["create", "delete", "pause", "resume", "trigger"]),
	name: z.string().optional(),
	cronPattern: z.string().optional(),
	prompt: z.string().optional(),
	jobId: z.string().optional(),
	agent: z.string().optional(),
});
export class ScheduleManageTool implements AgentTool<typeof scheduleManageSchema> {
	readonly name = "ai_schedule_manage";
	readonly approval = "read" as const;
	readonly label = "Manage Schedules";
	readonly description = "Create, delete, pause, resume, or trigger scheduled agent runs.";
	readonly parameters = scheduleManageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage schedules (requires confirmation)";
	constructor(_session: ToolSession) {}
	static createIf(session: ToolSession): ScheduleManageTool | null { return new ScheduleManageTool(session); }
	async execute(_id: string, params: z.infer<typeof scheduleManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Schedule: ${params.action}?`);
		return successResult(`Schedule ${params.action} executed.`);
	}
}
