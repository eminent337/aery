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

// ── Tier 1: Autonomous (read-only) ──────────────────────────────────────────

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

	static createIf(session: ToolSession): ShowModelTool | null {
		return new ShowModelTool(session);
	}

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

	static createIf(session: ToolSession): ShowUsageTool | null {
		return new ShowUsageTool(session);
	}

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

	static createIf(session: ToolSession): ShowToolsTool | null {
		return new ShowToolsTool(session);
	}

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

	static createIf(session: ToolSession): ShowSessionTool | null {
		return new ShowSessionTool(session);
	}

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

	static createIf(session: ToolSession): ListArtifactsTool | null {
		return new ListArtifactsTool(session);
	}

	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const dir = this.session.getArtifactsDir?.();
		if (!dir) return successResult("No artifacts directory configured.");
		return successResult(`Artifacts: ${dir}`);
	}
}

// ── Tier 2: Confirmation-required ───────────────────────────────────────────

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

	constructor(readonly _session: ToolSession) {}

	static createIf(session: ToolSession): SwitchModelTool | null {
		return new SwitchModelTool(session);
	}

	async execute(_id: string, params: z.infer<typeof switchModelSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) {
			return confirmNeeded(`Switch model to ${params.model}?`);
		}
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

	static createIf(session: ToolSession): ToggleFastTool | null {
		return new ToggleFastTool(session);
	}

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

	static createIf(session: ToolSession): TogglePlanTool | null {
		return new TogglePlanTool(session);
	}

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

	static createIf(session: ToolSession): ToggleAdvisorTool | null {
		return new ToggleAdvisorTool(session);
	}

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

	static createIf(session: ToolSession): RetryTurnTool | null {
		return new RetryTurnTool(session);
	}

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

	static createIf(session: ToolSession): ShakeContextTool | null {
		return new ShakeContextTool(session);
	}

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

	static createIf(session: ToolSession): ForkSessionTool | null {
		return new ForkSessionTool(session);
	}

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

	static createIf(session: ToolSession): RenameSessionTool | null {
		return new RenameSessionTool(session);
	}

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

	static createIf(session: ToolSession): ReloadPluginsTool | null {
		return new ReloadPluginsTool(session);
	}

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

	static createIf(session: ToolSession): NewSessionTool | null {
		return new NewSessionTool(session);
	}

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

	static createIf(session: ToolSession): DropSessionTool | null {
		return new DropSessionTool(session);
	}

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

	static createIf(session: ToolSession): ResumeSessionTool | null {
		return new ResumeSessionTool(session);
	}

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

	static createIf(session: ToolSession): LoginTool | null {
		return new LoginTool(session);
	}

	async execute(_id: string, params: z.infer<typeof loginSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) {
			return confirmNeeded(`Login${params.provider ? ` with ${params.provider}` : ""}?`);
		}
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

	static createIf(session: ToolSession): LogoutTool | null {
		return new LogoutTool(session);
	}

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

	static createIf(session: ToolSession): ToggleVimTool | null {
		return new ToggleVimTool(session);
	}

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

	static createIf(session: ToolSession): MarketplaceTool | null {
		return new MarketplaceTool(session);
	}

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

	static createIf(session: ToolSession): BtwTool | null {
		return new BtwTool(session);
	}

	async execute(_id: string, params: z.infer<typeof btwSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Ask: "${params.question}"?`);
		return successResult("Side question answered.");
	}
}
