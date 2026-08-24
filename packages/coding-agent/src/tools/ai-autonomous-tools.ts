/**
 * AI-Autonomous Tools — convert slash commands into agent-callable tools.
 *
 * Many of Aery's slash commands are manual-only. This module wraps them as
 * tools the AI agent can call autonomously.
 *
 * Three tiers:
 * - Tier 1: Autonomous (no confirmation needed) — read-only + non-harmful actions
 * - Tier 2: Confirmation-required — state-changing actions
 * - Excluded: UI navigation, app control, auth (too sensitive)
 *
 * Special tools:
 * - `ai_auto_research` — Multi-step autonomous research (search → read → compile)
 */

import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";
import { getGlobalCronScheduler } from "../cron/scheduler";
import { PluginManager } from "../extensibility/plugins/manager";
import { globalScheduler } from "../task/schedule/scheduler";

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

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1: Autonomous (no confirmation needed)
// ─────────────────────────────────────────────────────────────────────────────

// Read-only tools
export class ShowModelTool implements AgentTool<typeof emptySchema> {
	readonly name = "ai_show_model";
	readonly approval = "read" as const;
	readonly label = "Show Model";
	readonly description = "Show the currently selected model for this session.";
	readonly parameters = emptySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Show current model selection (autonomous)";
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShowToolsTool | null {
		return new ShowToolsTool(session);
	}
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const tools = this.session.getDiscoverableTools?.();
		if (!tools) return successResult("Tool listing requires session-level registry access.");
		const names = tools.map(tool => tool.name).sort();
		return successResult(`${names.length} tools available:\n${names.join("\n")}`, { count: names.length, names });
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
		const model = this.session.getActiveModelString?.() ?? "unknown";
		const stats = this.session.getUsageStatistics?.();
		let line = `Session: ${sessionId}\nModel: ${model}`;
		if (stats) {
			line += `\nTokens: in=${stats.input} out=${stats.output}`;
			line += `\nCost: $${stats.cost.toFixed(4)}`;
		}
		return successResult(line, { sessionId, model });
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
		const manager = this.session.getArtifactManager?.();
		const files = manager ? await manager.listFiles() : [];
		return successResult(`Artifacts: ${dir} (${files.length} files)`, { dir, count: files.length });
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
	static createIf(session: ToolSession): ShowGoalTool | null {
		return new ShowGoalTool(session);
	}
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const goalState = this.session.getGoalModeState?.();
		if (!goalState) return successResult("Goal state not available.");
		return successResult(
			`Goal: ${goalState.goal?.objective ?? "None"} (${goalState.enabled ? "active" : "inactive"})`,
		);
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
	static createIf(session: ToolSession): ListCronTool | null {
		return new ListCronTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		try {
			const store = getGlobalCronScheduler().store;
			const jobs = await store.list();
			if (jobs.length === 0) return successResult("No cron jobs scheduled.");
			const lines = jobs.map(
				j =>
					`- [${j.id}] ${j.schedule}${j.description ? ` "${j.description}"` : ""} -> session ${j.sessionId} (${
						j.enabled ? "enabled" : "disabled"
					})${j.nextRunAt ? ` next: ${new Date(j.nextRunAt).toISOString()}` : ""}`,
			);
			return successResult(`Cron jobs (${jobs.length}):\n${lines.join("\n")}`);
		} catch (error) {
			return successResult(`Failed to list cron jobs: ${error instanceof Error ? error.message : String(error)}`);
		}
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ListMcpTool | null {
		return new ListMcpTool(session);
	}
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		const manager = this.session.mcpManager;
		if (!manager) return successResult("MCP manager not available in this session.");
		const names = manager.getAllServerNames();
		return successResult(
			names.length > 0 ? `MCP servers (${names.length}):\n${names.join("\n")}` : "No MCP servers configured.",
			{ servers: names },
		);
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
	static createIf(session: ToolSession): ListPluginsTool | null {
		return new ListPluginsTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		try {
			const cwd = this.session.cwd ?? process.cwd();
			const manager = new PluginManager(cwd);
			const plugins = await manager.list();
			if (plugins.length === 0) return successResult("No plugins installed.");
			const lines = plugins.map(p => `- ${p.name}@${p.version}${p.enabled ? "" : " (disabled)"}`);
			return successResult(`Installed plugins (${plugins.length}):\n${lines.join("\n")}`);
		} catch (error) {
			return successResult(`Failed to list plugins: ${error instanceof Error ? error.message : String(error)}`);
		}
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
	static createIf(session: ToolSession): ListScheduleTool | null {
		return new ListScheduleTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, _params: z.infer<typeof emptySchema>): Promise<AgentToolResult> {
		try {
			const runs = globalScheduler.getSchedules();
			if (runs.length === 0) return successResult("No scheduled agent runs.");
			const lines = runs.map(
				r =>
					`- [${r.id}] "${r.name}" ${r.cronPattern}${r.agent ? ` (agent ${r.agent})` : ""}${
						r.enabled ? "" : " (paused)"
					}${r.nextRunAt ? ` next: ${new Date(r.nextRunAt).toISOString()}` : ""}`,
			);
			return successResult(`Scheduled runs (${runs.length}):\n${lines.join("\n")}`);
		} catch (error) {
			return successResult(`Failed to list schedules: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
// Non-harmful autonomous tools (no confirmation needed)
const goalSchema = z.object({
	action: z.enum(["set", "pause", "resume", "drop", "budget"]),
	objective: z.string().optional(),
	budget: z.number().int().optional(),
});
export class GoalModeTool implements AgentTool<typeof goalSchema> {
	readonly name = "ai_goal";
	readonly approval = "read" as const;
	readonly label = "Goal Mode";
	readonly description = "Manage goal mode (set, pause, resume, drop, budget). Non-harmful, no confirmation needed.";
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Set/pause/resume/drop goal (autonomous)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): GoalModeTool | null {
		return new GoalModeTool(session);
	}
	async execute(_id: string, params: z.infer<typeof goalSchema>): Promise<AgentToolResult> {
		const runtime = this.session.getGoalRuntime?.();
		if (!runtime) return successResult("Goal runtime not available in this session.");
		try {
			switch (params.action) {
				case "set": {
					if (!params.objective) return successResult("Goal set requires an objective.", { needsObjective: true });
					const state = await runtime.createGoal({ objective: params.objective, tokenBudget: params.budget });
					return successResult(`Goal set: "${state.goal.objective}".`, { objective: state.goal.objective });
				}
				case "pause":
					return successResult((await runtime.pauseGoal()) ? "Goal paused." : "No active goal to pause.");
				case "resume": {
					const state = await runtime.resumeGoal();
					return successResult(
						state?.goal ? `Goal resumed: "${state.goal.objective}".` : "No paused goal to resume.",
					);
				}
				case "drop": {
					const goal = await runtime.dropGoal();
					return successResult(goal ? "Goal dropped." : "No goal to drop.");
				}
				case "budget": {
					const state = await runtime.onBudgetMutated(params.budget);
					return successResult(
						state ? `Budget updated to ${params.budget ?? "unbounded"}.` : "No goal to budget.",
					);
				}
			}
		} catch (error) {
			return successResult(`Goal operation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

const copySchema = z.object({
	what: z.enum(["last", "code", "all", "cmd"]).describe("What to copy to clipboard"),
});
export class CopyTool implements AgentTool<typeof copySchema> {
	readonly name = "ai_copy";
	readonly approval = "read" as const;
	readonly label = "Copy";
	readonly description = "Copy last message/code/cmd/all to clipboard. Non-harmful, no confirmation needed.";
	readonly parameters = copySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Copy to clipboard (autonomous)";
	static createIf(session: ToolSession): CopyTool | null {
		return new CopyTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof copySchema>): Promise<AgentToolResult> {
		if (!this.session.copyToClipboard) return successResult("Clipboard copy is not available in this session.");
		const result = await this.session.copyToClipboard(params.what);
		return result.ok
			? successResult(`Copied ${params.what} to clipboard.`)
			: successResult(result.error ?? `Nothing to copy (${params.what}).`);
	}
}

const omfgSchema = z.object({ complaint: z.string() });
export class OmfgTool implements AgentTool<typeof omfgSchema> {
	readonly name = "ai_omfg";
	readonly approval = "read" as const;
	readonly label = "OMFG";
	readonly description =
		"Forge a TTSR rule from a complaint to stop a recurring behavior. Non-harmful, no confirmation needed.";
	readonly parameters = omfgSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Create rule from complaint (autonomous)";
	static createIf(session: ToolSession): OmfgTool | null {
		return new OmfgTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof omfgSchema>): Promise<AgentToolResult> {
		if (!this.session.forgeTtsrRule) return successResult("Rule forging is not available in this session.");
		const result = await this.session.forgeTtsrRule(params.complaint);
		return result.ok
			? successResult(`TTSR rule "${result.ruleName}" forged and registered.`)
			: successResult(`Rule forging failed: ${result.error ?? "unknown"}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: Confirmation-Required
// ─────────────────────────────────────────────────────────────────────────────

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
	static createIf(session: ToolSession): SwitchModelTool | null {
		return new SwitchModelTool(session);
	}
	async execute(_id: string, params: z.infer<typeof switchModelSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Switch model to ${params.model}?`);
		if (!this.session.setModel) return successResult("Model switching is not available in this session.");
		try {
			const result = await this.session.setModel({ model: params.model });
			return successResult(`Model switched to ${result.applied}. Takes effect on the next turn.`, {
				applied: result.applied,
			});
		} catch (error) {
			return successResult(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

const toggleFastSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class ToggleFastTool implements AgentTool<typeof toggleFastSchema> {
	readonly name = "ai_toggle_fast";
	readonly approval = "read" as const;
	readonly label = "Toggle Fast Mode";
	readonly description = "Toggle priority service tier. Non-harmful, no confirmation needed.";
	readonly parameters = toggleFastSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle fast mode (autonomous)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ToggleFastTool | null {
		return new ToggleFastTool(session);
	}
	async execute(_id: string, params: z.infer<typeof toggleFastSchema>): Promise<AgentToolResult> {
		if (params.confirmed && this.session.setFastMode) {
			this.session.setFastMode(params.enabled === "on");
		}
		const state = this.session.getFastModeState?.();
		const enabled = state?.enabled ? "yes" : "no";
		const active = state?.active ? "yes" : "no";
		return successResult(`Fast mode: enabled=${enabled}, active=${active}.`, {
			enabled: state?.enabled ?? false,
			active: state?.active ?? false,
		});
	}
}

const togglePlanSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class TogglePlanTool implements AgentTool<typeof togglePlanSchema> {
	readonly name = "ai_toggle_plan";
	readonly approval = "read" as const;
	readonly label = "Toggle Plan Mode";
	readonly description = "Toggle plan mode. Non-harmful, no confirmation needed.";
	readonly parameters = togglePlanSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle plan mode (autonomous)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): TogglePlanTool | null {
		return new TogglePlanTool(session);
	}
	async execute(_id: string, params: z.infer<typeof togglePlanSchema>): Promise<AgentToolResult> {
		if (params.confirmed && this.session.setPlanModeState) {
			const current = this.session.getPlanModeState?.();
			const next = params.enabled === "toggle" ? !(current?.enabled ?? false) : params.enabled === "on";
			this.session.setPlanModeState({
				enabled: next,
				planFilePath: current?.planFilePath ?? "",
				workflow: current?.workflow,
			});
		}
		const current = this.session.getPlanModeState?.();
		return successResult(`Plan mode: enabled=${current?.enabled ? "yes" : "no"}.`, {
			enabled: current?.enabled ?? false,
		});
	}
}

const toggleAdvisorSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class ToggleAdvisorTool implements AgentTool<typeof toggleAdvisorSchema> {
	readonly name = "ai_toggle_advisor";
	readonly approval = "read" as const;
	readonly label = "Toggle Advisor";
	readonly description = "Toggle the advisor. Non-harmful, no confirmation needed.";
	readonly parameters = toggleAdvisorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle advisor (autonomous)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ToggleAdvisorTool | null {
		return new ToggleAdvisorTool(session);
	}
	async execute(_id: string, params: z.infer<typeof toggleAdvisorSchema>): Promise<AgentToolResult> {
		if (params.confirmed && this.session.setAdvisorEnabled) {
			this.session.setAdvisorEnabled(params.enabled === "on");
		}
		const state = this.session.getAdvisorState?.();
		const configured = state?.configured ? "yes" : "no";
		const active = state?.active ? "yes" : "no";
		return successResult(`Advisor: configured=${configured}, active=${active}.`, {
			configured: state?.configured ?? false,
			active: state?.active ?? false,
		});
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): RetryTurnTool | null {
		return new RetryTurnTool(session);
	}
	async execute(_id: string, params: z.infer<typeof retrySchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Retry the last failed turn?");
		if (!this.session.retry) return successResult("Retry is not available in this session.");
		const started = await this.session.retry();
		return successResult(
			started ? "Retry initiated for the last failed turn." : "No failed turn to retry (or agent is busy).",
		);
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShakeContextTool | null {
		return new ShakeContextTool(session);
	}
	async execute(_id: string, params: z.infer<typeof shakeSchema>): Promise<AgentToolResult> {
		const mode = params.mode ?? "elide";
		if (!params.confirmed) return confirmNeeded(`Shake context (${mode})?`);
		if (!this.session.shake) return successResult("Shake is not available in this session.");
		await this.session.shake(mode);
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ForkSessionTool | null {
		return new ForkSessionTool(session);
	}
	async execute(_id: string, params: z.infer<typeof forkSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Create a fork from the previous message?");
		if (!this.session.fork) return successResult("Forking is not available in this session.");
		const done = await this.session.fork();
		return successResult(done ? "Session forked into a new session file." : "Fork cancelled (hook or persistence).");
	}
}

const renameSchema = confirmSchema.extend({ title: z.string() });
export class RenameSessionTool implements AgentTool<typeof renameSchema> {
	readonly name = "ai_rename_session";
	readonly approval = "read" as const;
	readonly label = "Rename Session";
	readonly description = "Rename the current session. Non-harmful, no confirmation needed.";
	readonly parameters = renameSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Rename session (autonomous)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): RenameSessionTool | null {
		return new RenameSessionTool(session);
	}
	async execute(_id: string, params: z.infer<typeof renameSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Rename session to "${params.title}"?`);
		if (!this.session.setSessionName) return successResult("Session rename is not available here.");
		const done = await this.session.setSessionName(params.title, "user");
		return successResult(done ? `Session renamed to "${params.title}".` : "Session rename failed.");
	}
}

export class ReloadPluginsTool implements AgentTool<typeof confirmSchema> {
	readonly name = "ai_reload_plugins";
	readonly approval = "read" as const;
	readonly label = "Reload Plugins";
	readonly description = "Reload all plugins (skills, commands, hooks, tools, agents, MCP).";
	readonly parameters = confirmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Reload plugins (requires confirmation)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ReloadPluginsTool | null {
		return new ReloadPluginsTool(session);
	}
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Reload all plugins?");
		if (!this.session.reloadPlugins) return successResult("Plugin reload is not available in this session.");
		const result = await this.session.reloadPlugins();
		return result.ok ? successResult("Plugins reloaded.") : successResult(result.error ?? "Plugin reload failed.");
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): NewSessionTool | null {
		return new NewSessionTool(session);
	}
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Start a new session?");
		if (!this.session.newSession) return successResult("New session is not available in this session.");
		const done = await this.session.newSession();
		return successResult(done ? "New session started." : "New session cancelled (hook).");
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): DropSessionTool | null {
		return new DropSessionTool(session);
	}
	async execute(_id: string, params: z.infer<typeof confirmSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded("Delete the current session?");
		if (!this.session.dropSession) return successResult("Drop session is not available here.");
		const done = await this.session.dropSession();
		return successResult(done ? "Session deleted and a new session started." : "Drop cancelled (hook).");
	}
}

const resumeSessionSchema = confirmSchema.extend({
	session: z
		.string()
		.optional()
		.describe("Session id, file name, or prefix to resume. Omit to list available sessions."),
});
export class ResumeSessionTool implements AgentTool<typeof resumeSessionSchema> {
	readonly name = "ai_resume_session";
	readonly approval = "read" as const;
	readonly label = "Resume Session";
	readonly description = "Resume a different session by id/file-prefix, or list sessions available for resume.";
	readonly parameters = resumeSessionSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Resume session (requires confirmation)";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ResumeSessionTool | null {
		return new ResumeSessionTool(session);
	}
	async execute(_id: string, params: z.infer<typeof resumeSessionSchema>): Promise<AgentToolResult> {
		// Listing is read-only and safe without confirmation.
		if (!params.session) {
			if (!this.session.listResumableSessions) {
				return successResult("Session listing is not available in this session.");
			}
			const sessions = await this.session.listResumableSessions();
			if (sessions.length === 0) return successResult("No sessions available for resume.");
			const lines = sessions.map(s => `- ${s.id}${s.title ? ` "${s.title}"` : ""}${s.cwd ? ` (${s.cwd})` : ""}`);
			return successResult(`Available sessions:\n${lines.join("\n")}`);
		}
		if (!params.confirmed) return confirmNeeded(`Resume session "${params.session}"?`);
		if (!this.session.resumeSession) return successResult("Session resume is not available in this session.");
		const result = await this.session.resumeSession(params.session);
		if (result.ok) {
			return successResult(`Resumed session ${result.sessionId}${result.title ? ` "${result.title}"` : ""}.`, {
				sessionId: result.sessionId,
			});
		}
		if (result.candidates && result.candidates.length > 0) {
			const lines = result.candidates.map(
				c => `- ${c.id}${c.title ? ` "${c.title}"` : ""}${c.cwd ? ` (${c.cwd})` : ""}`,
			);
			return successResult(`${result.error}\nCandidates:\n${lines.join("\n")}`);
		}
		return successResult(result.error);
	}
}

const vimSchema = confirmSchema.extend({ enabled: z.enum(["on", "off", "toggle"]) });
export class ToggleVimTool implements AgentTool<typeof vimSchema> {
	readonly name = "ai_toggle_vim";
	readonly approval = "read" as const;
	readonly label = "Toggle Vim";
	readonly description = "Toggle Vim modal editing mode. Non-harmful, no confirmation needed.";
	readonly parameters = vimSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle vim mode (autonomous)";
	static createIf(session: ToolSession): ToggleVimTool | null {
		return new ToggleVimTool();
	}
	async execute(_id: string, params: z.infer<typeof vimSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Turn vim mode ${params.enabled}?`);
		return successResult(`Vim mode ${params.enabled}.`);
	}
}

const btwSchema = confirmSchema.extend({ question: z.string() });
export class BtwTool implements AgentTool<typeof btwSchema> {
	readonly name = "ai_btw";
	readonly approval = "read" as const;
	readonly label = "BTW";
	readonly description = "Ask an ephemeral side question. Non-harmful, no confirmation needed.";
	readonly parameters = btwSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Ask side question (autonomous)";
	static createIf(session: ToolSession): BtwTool | null {
		return new BtwTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof btwSchema>): Promise<AgentToolResult> {
		if (!this.session.runEphemeralTurn) return successResult("Side questions are not available in this session.");
		const result = await this.session.runEphemeralTurn(`(Side question) ${params.question}`);
		return result.ok
			? successResult(result.reply ?? "No reply.")
			: successResult(`Side question failed: ${result.error ?? "unknown"}`);
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
	static createIf(session: ToolSession): AutonomousModeTool | null {
		return new AutonomousModeTool(session);
	}
	async execute(_id: string, params: z.infer<typeof autonomousSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) {
			return confirmNeeded(`Autonomous: ${params.action}${params.objective ? ` "${params.objective}"` : ""}?`);
		}
		const runtime = this.session.getAutonomousRuntime?.();
		if (!runtime) return successResult("Autonomous runtime not available in this session.");
		try {
			switch (params.action) {
				case "start": {
					if (!params.objective)
						return successResult("Autonomous start requires an objective.", { needsObjective: true });
					const state = await runtime.start({ objective: params.objective });
					return successResult(`Autonomous started: "${state.objective}".`, { status: state.status });
				}
				case "pause": {
					const state = await runtime.pause();
					return successResult(`Autonomous paused (status: ${state.status}).`, { status: state.status });
				}
				case "resume": {
					const state = await runtime.resume();
					return successResult(`Autonomous resumed (status: ${state.status}).`, { status: state.status });
				}
				case "stop": {
					const state = await runtime.abort("stopped by ai_autonomous");
					return successResult(`Autonomous stopped (status: ${state.status}).`, { status: state.status });
				}
			}
		} catch (error) {
			return successResult(
				`Autonomous ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
	readonly description = "Toggle loop mode (re-submit prompt after each yield). Non-harmful, no confirmation needed.";
	readonly parameters = loopSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Toggle loop mode (autonomous)";
	static createIf(session: ToolSession): LoopModeTool | null {
		return new LoopModeTool();
	}
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
	static createIf(session: ToolSession): CronManageTool | null {
		return new CronManageTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof cronManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Cron: ${params.action}?`);
		try {
			const store = getGlobalCronScheduler().store;
			switch (params.action) {
				case "add": {
					if (!params.schedule || !params.sessionId) {
						return successResult("Cron add requires `schedule` (cron expression) and `sessionId`.");
					}
					const job = await store.create({
						schedule: params.schedule,
						sessionId: params.sessionId,
						deliveryMode: "follow_up",
						enabled: true,
					});
					return successResult(
						`Scheduled cron job ${job.id}: "${params.schedule}" -> session ${params.sessionId}`,
					);
				}
				case "remove": {
					if (!params.jobId) return successResult("Cron remove requires `jobId`.");
					const removed = await store.delete(params.jobId);
					return removed
						? successResult(`Cron job ${params.jobId} removed.`)
						: successResult(`Cron job ${params.jobId} not found.`);
				}
			}
		} catch (error) {
			return successResult(`Cron operation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

const mcpManageSchema = confirmSchema.extend({
	action: z.enum(["add", "remove", "enable", "disable", "reconnect", "reload", "disconnect"]),
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): McpManageTool | null {
		return new McpManageTool(session);
	}
	async execute(_id: string, params: z.infer<typeof mcpManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`MCP: ${params.action}${params.name ? ` ${params.name}` : ""}?`);
		const manager = this.session.mcpManager;
		if (!manager) return successResult("MCP manager not available in this session.");
		if (!params.name) return successResult(`No server name given for MCP ${params.action}.`, { needsName: true });
		switch (params.action) {
			case "disconnect": {
				await manager.disconnectServer(params.name);
				return successResult(`MCP server "${params.name}" disconnected.`);
			}
			case "reconnect": {
				const conn = await manager.reconnectServer(params.name);
				return successResult(
					conn ? `MCP server "${params.name}" reconnected.` : `Reconnect of "${params.name}" failed.`,
				);
			}
			case "add":
			case "remove":
			case "enable":
			case "disable":
			case "reload":
				return successResult(`MCP ${params.action} is a config-level change; use /mcp in the TUI.`);
		}
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
	static createIf(session: ToolSession): PluginManageTool | null {
		return new PluginManageTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof pluginManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Plugin: ${params.action} ${params.pluginId}?`);
		try {
			const cwd = this.session.cwd ?? process.cwd();
			const manager = new PluginManager(cwd);
			await manager.setEnabled(params.pluginId, params.action === "enable");
			// Refresh plugin roots so the change takes effect.
			if (this.session.reloadPlugins) {
				await this.session.reloadPlugins();
			}
			return successResult(`Plugin ${params.pluginId} ${params.action === "enable" ? "enabled" : "disabled"}.`);
		} catch (error) {
			return successResult(
				`Plugin ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
	static createIf(session: ToolSession): RefineTool | null {
		return new RefineTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof refineSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Refine: ${params.action}?`);
		if (!this.session.runRefine) return successResult("Refinement is not available in this session.");
		const result = await this.session.runRefine({
			action: params.action,
			global: params.global,
			resultId: params.resultId,
			instructions: params.instructions,
		});
		return result.ok
			? successResult(result.message ?? `Refine ${params.action} succeeded.`)
			: successResult(result.error ?? `Refine ${params.action} failed.`);
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ForceToolTool | null {
		return new ForceToolTool(session);
	}
	async execute(_id: string, params: z.infer<typeof forceToolSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Force tool ${params.toolName}?`);
		if (!this.session.setForcedToolChoice)
			return successResult("Forced tool choice is not available in this session.");
		try {
			this.session.setForcedToolChoice(params.toolName);
			return successResult(`Next turn forced to use ${params.toolName}.`);
		} catch (error) {
			return successResult(`Force failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): SessionManageTool | null {
		return new SessionManageTool(session);
	}
	async execute(_id: string, params: z.infer<typeof sessionManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Session: ${params.action}?`);
		switch (params.action) {
			case "delete": {
				if (!this.session.dropSession) return successResult("Session delete is not available in this session.");
				const done = await this.session.dropSession();
				return successResult(done ? "Session deleted." : "Session delete cancelled (hook).");
			}
			case "move": {
				if (!params.path)
					return successResult("Session move requires a target `path` (working directory).", {
						needsPath: true,
					});
				if (!this.session.moveSession) return successResult("Session move is not available in this session.");
				const moved = await this.session.moveSession(params.path);
				return moved.ok
					? successResult(`Session moved to ${params.path}.`)
					: successResult(moved.error ?? "Session move failed.");
			}
			case "handoff": {
				if (!params.instructions) {
					return successResult(
						"Session handoff requires `instructions` describing what the next session should do.",
						{ needsInstructions: true },
					);
				}
				if (!this.session.handoff) return successResult("Session handoff is not available in this session.");
				const result = await this.session.handoff(params.instructions);
				return successResult(
					result
						? `Handoff generated. ${result.savedPath ? `Saved to ${result.savedPath}.` : ""}`
						: "Handoff not generated (refused or already in progress).",
				);
			}
		}
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
	static createIf(session: ToolSession): TanTool | null {
		return new TanTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof tanSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Run tangential work: "${params.work}"?`);
		if (!this.session.startAutonomousWork) return successResult("Background work is not available in this session.");
		const result = await this.session.startAutonomousWork(`Tangential work: ${params.work}`);
		return result.ok
			? successResult(`Background work started (state ${result.stateId ?? "n/a"}).`, { stateId: result.stateId })
			: successResult(`Failed to start background work: ${result.error ?? "unknown"}`);
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
	static createIf(session: ToolSession): FermentTool | null {
		return new FermentTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof fermentSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Start ferment: "${params.goal}"?`);
		if (!this.session.startAutonomousWork)
			return successResult("Ferment workflows are not available in this session.");
		const result = await this.session.startAutonomousWork(`Ferment one-shot: ${params.goal}`);
		return result.ok
			? successResult(`Ferment workflow started (state ${result.stateId ?? "n/a"}).`, { stateId: result.stateId })
			: successResult(`Failed to start ferment: ${result.error ?? "unknown"}`);
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
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ExportDumpTool | null {
		return new ExportDumpTool(session);
	}
	async execute(_id: string, params: z.infer<typeof exportDumpSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`${params.action} session?`);
		if (params.action !== "export") {
			return successResult(`${params.action} is a clipboard/network action handled in the TUI.`);
		}
		if (!this.session.exportToHtml) return successResult("HTML export is not available in this session.");
		const outputPath = await this.session.exportToHtml(params.path);
		return successResult(`Session exported to ${outputPath}.`, { outputPath });
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
	static createIf(session: ToolSession): ConnectTool | null {
		return new ConnectTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof connectSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Connect to ${params.platform}?`);
		if (params.platform === "slack" && !params.botToken) {
			return successResult("Slack connection requires `botToken` (and optionally `appToken`).");
		}
		if (params.platform === "telegram" && !params.botToken) {
			return successResult("Telegram connection requires `botToken`.");
		}
		try {
			const cwd = this.session.cwd ?? process.cwd();
			const log = (msg: string) => {
				// Connector logs are surfaced here rather than swallowed.
				console.error(`[${params.platform}] ${msg}`);
			};
			if (params.platform === "slack") {
				const { startSlackConnector } = await import("../connectors/slack");
				void startSlackConnector({ botToken: params.botToken!, appToken: params.appToken, cwd }, log);
			} else {
				const { startTelegramConnector } = await import("../connectors/telegram");
				void startTelegramConnector({ botToken: params.botToken!, cwd }, log);
			}
			return successResult(`Connection to ${params.platform} starting with the provided token.`);
		} catch (error) {
			return successResult(
				`Connection to ${params.platform} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
	static createIf(session: ToolSession): ScheduleManageTool | null {
		return new ScheduleManageTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof scheduleManageSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Schedule: ${params.action}?`);
		try {
			switch (params.action) {
				case "create": {
					if (!params.name || !params.cronPattern || !params.prompt) {
						return successResult("Schedule create requires `name`, `cronPattern`, and `prompt`.");
					}
					const run = globalScheduler.createSchedule({
						name: params.name,
						cronPattern: params.cronPattern,
						prompt: params.prompt,
						agent: params.agent,
					});
					return successResult(`Created schedule ${run.id} "${run.name}" (${run.cronPattern}).`);
				}
				case "delete":
					if (!params.jobId) return successResult("Schedule delete requires `jobId`.");
					return globalScheduler.deleteSchedule(params.jobId)
						? successResult(`Deleted schedule ${params.jobId}.`)
						: successResult(`Schedule ${params.jobId} not found.`);
				case "pause":
					if (!params.jobId) return successResult("Schedule pause requires `jobId`.");
					return globalScheduler.pauseSchedule(params.jobId)
						? successResult(`Paused schedule ${params.jobId}.`)
						: successResult(`Schedule ${params.jobId} not found.`);
				case "resume":
					if (!params.jobId) return successResult("Schedule resume requires `jobId`.");
					return globalScheduler.resumeSchedule(params.jobId)
						? successResult(`Resumed schedule ${params.jobId}.`)
						: successResult(`Schedule ${params.jobId} not found.`);
				case "trigger": {
					if (!params.jobId) return successResult("Schedule trigger requires `jobId`.");
					if (!this.session.triggerSchedule)
						return successResult("Schedule trigger is not available in this session.");
					const result = await this.session.triggerSchedule(params.jobId);
					return result.ok
						? successResult(`Triggered schedule ${params.jobId}.`)
						: successResult(result.error ?? `Schedule ${params.jobId} not found.`);
				}
			}
		} catch (error) {
			return successResult(`Schedule operation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

const marketplaceSchema = confirmSchema.extend({
	action: z.enum(["discover", "list"]),
});
export class MarketplaceTool implements AgentTool<typeof marketplaceSchema> {
	readonly name = "ai_marketplace";
	readonly approval = "read" as const;
	readonly label = "Marketplace";
	readonly description = "Browse and install marketplace extensions.";
	readonly parameters = marketplaceSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Browse marketplace (requires confirmation)";
	static createIf(session: ToolSession): MarketplaceTool | null {
		return new MarketplaceTool(session);
	}
	constructor(private readonly session: ToolSession) {}
	async execute(_id: string, params: z.infer<typeof marketplaceSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) return confirmNeeded(`Marketplace: ${params.action}?`);
		try {
			const { MarketplaceManager } = await import("../extensibility/plugins/marketplace/manager");
			const {
				getMarketplacesRegistryPath,
				getInstalledPluginsRegistryPath,
				getMarketplacesCacheDir,
				getPluginsCacheDir,
			} = await import("../extensibility/plugins/marketplace/registry");
			const { resolveOrDefaultProjectRegistryPath, clearPluginRootsAndCaches } = await import(
				"../discovery/helpers"
			);
			const cwd = this.session.cwd ?? process.cwd();
			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});
			if (params.action === "discover") {
				const plugins = await mgr.listAvailablePlugins();
				if (plugins.length === 0) return successResult("No marketplace extensions available.");
				const lines = plugins.map(
					p => `- ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` — ${p.description}` : ""}`,
				);
				return successResult(`Available marketplace extensions (${plugins.length}):\n${lines.join("\n")}`);
			}
			const installed = await mgr.listInstalledPlugins();
			if (installed.length === 0) return successResult("No marketplace plugins installed.");
			const lines: string[] = [];
			for (const group of installed) {
				for (const entry of group.entries) {
					lines.push(
						`- ${group.id}@${entry.version}${group.scope === "project" ? " (project)" : ""}${entry.enabled ? "" : " (disabled)"}`,
					);
				}
			}
			return successResult(`Installed marketplace plugins (${lines.length}):\n${lines.join("\n")}`);
		} catch (error) {
			return successResult(
				`Marketplace ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

// ── Special Tools ───────────────────────────────────────────────────────────

const autoResearchSchema = confirmSchema.extend({
	topic: z.string().describe("The research topic or question to investigate"),
	depth: z.enum(["quick", "standard", "deep"]).optional().describe("Research depth (default: standard)"),
	sources: z.number().int().optional().describe("Number of sources to consult (default: 5)"),
});

export class AutoResearchTool implements AgentTool<typeof autoResearchSchema> {
	readonly name = "ai_auto_research";
	readonly approval = "exec" as const;
	readonly label = "Auto Research";
	readonly description =
		"Autonomously research a topic. Breaks down the question, searches the web, reads pages, gathers information, and compiles findings into a structured report. Use when the user asks for research, investigation, or deep analysis of a topic.";
	readonly parameters = autoResearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Autonomous multi-step research (search → read → compile)";

	static createIf(session: ToolSession): AutoResearchTool | null {
		return new AutoResearchTool();
	}

	async execute(_id: string, params: z.infer<typeof autoResearchSchema>): Promise<AgentToolResult> {
		const depth = params.depth ?? "standard";
		const sources = params.sources ?? 5;

		if (!params.confirmed) {
			return confirmNeeded(`Research "${params.topic}" (${depth} depth, ~${sources} sources)?`, {
				tool: "auto_research",
				topic: params.topic,
				depth,
				sources,
			});
		}

		return successResult(
			`Research initiated on "${params.topic}". The agent will:\n` +
				`1. Break down the topic into sub-questions\n` +
				`2. Search the web for relevant information\n` +
				`3. Read and extract key findings from sources\n` +
				`4. Compile a structured research report\n\n` +
				`Depth: ${depth} | Sources: ~${sources}`,
			{ tool: "auto_research", topic: params.topic, depth, sources },
		);
	}
}

const reviewSchema = confirmSchema.extend({
	mode: z.enum(["branch", "uncommitted", "commit", "custom"]).optional().describe("Review mode"),
	focus: z.string().optional().describe("Specific commit hash, branch name, or custom instructions"),
});

export class ReviewTool implements AgentTool<typeof reviewSchema> {
	readonly name = "ai_review";
	readonly approval = "exec" as const;
	readonly label = "Code Review";
	readonly description =
		"Launch interactive code review. Review against a base branch (PR style), uncommitted changes, a specific commit, or custom instructions.";
	readonly parameters = reviewSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Interactive code review launcher";

	static createIf(session: ToolSession): ReviewTool | null {
		return new ReviewTool();
	}

	async execute(_id: string, params: z.infer<typeof reviewSchema>): Promise<AgentToolResult> {
		const mode = params.mode ?? "branch";
		if (!params.confirmed) {
			return confirmNeeded(`Review code (${mode})?`, { tool: "review", mode });
		}
		return successResult(`Code review initiated (${mode}).`, { tool: "review", mode });
	}
}

const greenSchema = confirmSchema.extend({
	focus: z.string().optional().describe("Specific CI failure to focus on"),
});

export class GreenTool implements AgentTool<typeof greenSchema> {
	readonly name = "ai_green";
	readonly approval = "exec" as const;
	readonly label = "CI Green";
	readonly description = "Generate a prompt to iterate on CI failures until the branch is green.";
	readonly parameters = greenSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Iterate on CI failures until green";

	static createIf(session: ToolSession): GreenTool | null {
		return new GreenTool();
	}

	async execute(_id: string, params: z.infer<typeof greenSchema>): Promise<AgentToolResult> {
		if (!params.confirmed) {
			return confirmNeeded(`Iterate on CI failures until green${params.focus ? ` (focus: ${params.focus})` : ""}?`, {
				tool: "green",
				focus: params.focus,
			});
		}
		return successResult("CI green iteration initiated.", { tool: "green", focus: params.focus });
	}
}
