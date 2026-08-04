import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@aryee337/aery-ai/utils/oauth";
import type { AutocompleteItem } from "@aryee337/aery-tui";
import { Snowflake, setProjectDir } from "@aryee337/aery-utils";
import { $ } from "bun";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { getFermentArgumentCompletions } from "../ferment/extension/commands.js";
import { applyTransition } from "../ferment/state-machine.js";
import { FermentStore } from "../ferment/store.js";
import type { Ferment } from "../ferment/types.js";
import { getMarketplaceArgumentCompletions } from "../marketplace/marketplace.js";
import type { InteractiveModeContext } from "../modes/types";
import { globalScheduler } from "../task/schedule/scheduler";
import { getChangelogPath, parseChangelog } from "../utils/changelog";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import { buildUsageReportText } from "./helpers/usage-report";
import { parsePluginScopeArgs } from "./marketplace-install-parser";
import { pluginCommand } from "./plugin-command";
import { skillCommand } from "./skill-command";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef };

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	pluginCommand,
	skillCommand,
	{
		name: "connect",
		description: "Connect agent to external chat platforms",
		subcommands: [
			{ name: "slack", description: "Connect to Slack" },
			{ name: "telegram", description: "Connect to Telegram" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const args = command.args.trim().split(/\s+/);
			const connectorName = args[0];
			if (!connectorName) return usage("Usage: /connect <slack|telegram> --bot-token=...", runtime);

			const tokenArg = args.find(a => a.startsWith("--bot-token="));
			const botToken = tokenArg ? tokenArg.split("=")[1] : undefined;
			if (!botToken) return usage("Missing --bot-token=...", runtime);

			const appTokenArg = args.find(a => a.startsWith("--app-token="));
			const appToken = appTokenArg ? appTokenArg.split("=")[1] : undefined;

			const { startSlackConnector } = await import("../connectors/slack.js");
			const { startTelegramConnector } = await import("../connectors/telegram.js");

			try {
				if (connectorName === "slack") {
					await startSlackConnector(
						{ botToken, appToken, cwd: runtime.cwd },
						async msg => await runtime.output(msg),
					);
				} else if (connectorName === "telegram") {
					await startTelegramConnector({ botToken, cwd: runtime.cwd }, async msg => await runtime.output(msg));
				} else {
					return usage(`Unknown connector: ${connectorName}`, runtime);
				}
			} catch (err: any) {
				return usage(`Connector error: ${err.message}`, runtime);
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const args = command.args.trim().split(/\s+/);
			const connectorName = args[0];
			if (!connectorName) {
				runtime.ctx.showStatus("Enter the connector name (slack or telegram):");
				runtime.ctx.editor.setText("/connect ");
				if (typeof runtime.ctx.editor.setCursorPosition === "function") {
					runtime.ctx.editor.setCursorPosition(0, 9);
				}
				return;
			}
			const tokenArg = args.find(a => a.startsWith("--bot-token="));
			const botToken = tokenArg ? tokenArg.split("=")[1] : undefined;
			if (!botToken || botToken === '""') {
				if (connectorName === "slack") {
					runtime.ctx.showStatus("Paste your Slack tokens below and hit Enter!");
					const template = `/connect slack --bot-token="" --app-token=""`;
					runtime.ctx.editor.setText(template);
					if (typeof runtime.ctx.editor.setCursorPosition === "function") {
						runtime.ctx.editor.setCursorPosition(0, 28); // Inside the first quotes
					}
				} else if (connectorName === "telegram") {
					runtime.ctx.showStatus("Paste your Telegram bot token below and hit Enter!");
					const template = `/connect telegram --bot-token=""`;
					runtime.ctx.editor.setText(template);
					if (typeof runtime.ctx.editor.setCursorPosition === "function") {
						runtime.ctx.editor.setCursorPosition(0, 31); // Inside the quotes
					}
				} else {
					runtime.ctx.showStatus("Usage: /connect <slack|telegram> --bot-token=...");
					runtime.ctx.editor.setText("");
				}
				return;
			}
			const appTokenArg = args.find(a => a.startsWith("--app-token="));
			const appToken = appTokenArg ? appTokenArg.split("=")[1] : undefined;

			const { startSlackConnector } = await import("../connectors/slack.js");
			const { startTelegramConnector } = await import("../connectors/telegram.js");

			try {
				if (connectorName === "slack") {
					await startSlackConnector({ botToken, appToken, cwd: runtime.ctx.sessionManager.getCwd() }, msg =>
						runtime.ctx.showStatus(msg),
					);
				} else if (connectorName === "telegram") {
					await startTelegramConnector({ botToken, cwd: runtime.ctx.sessionManager.getCwd() }, msg =>
						runtime.ctx.showStatus(msg),
					);
				} else {
					runtime.ctx.showStatus(`Unknown connector: ${connectorName}`);
				}
			} catch (err: any) {
				runtime.ctx.showStatus(`Connector error: ${err.message}`);
			}
		},
	},
	{
		name: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hub",
		description: "Open the active Subagents TUI Dashboard Overlay",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSessionObserver();
			runtime.ctx.editor.setText("");
		},
	},

	{
		name: "vim",
		description: "Toggle Vim modal editing mode in the TUI",
		handleTui: async (_command, runtime) => {
			const { VimEditor } = await import("../modes/vim/vim-editor");
			const isVim = runtime.ctx.editor instanceof VimEditor;
			if (isVim) {
				runtime.ctx.setEditorComponent(undefined);
				runtime.ctx.showStatus("Vim mode disabled.");
			} else {
				runtime.ctx.setEditorComponent((_tui, theme) => {
					const next = new VimEditor(theme);
					next.setVimEnabled(true);
					return next;
				});
				runtime.ctx.showStatus("Vim mode enabled.");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const hadArgs = !!command.args;
			// Capture state BEFORE the call: when plan mode is already active,
			// handlePlanModeCommand may exit it (on confirmed exit) or leave it on (on cancel
			// or warning). In every "already active" case the typed args are NOT consumed,
			// so preserve them in history regardless of the user's confirm/cancel choice.
			const wasPlanModeEnabled = runtime.ctx.planModeEnabled;
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			if (hadArgs && wasPlanModeEnabled) {
				runtime.ctx.editor.addToHistory(command.text);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const hadArgs = !!command.args;
			// Capture state BEFORE the call (see /plan above for rationale).
			const wasGoalModeEnabled = runtime.ctx.goalModeEnabled;
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			if (hadArgs && wasGoalModeEnabled) {
				runtime.ctx.editor.addToHistory(command.text);
			}
			runtime.ctx.editor.setText("");
		},
	},

	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},

	{
		name: "model",
		aliases: ["models"],
		description: "Select model (opens selector UI)",
		acpDescription: "Show current model selection",
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		description: "Switch model for this session (same as alt+p)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				runtime.session.setFastMode(true);
				await runtime.output("Fast mode enabled.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${runtime.session.isFastModeEnabled() ? "on" : "off"}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode enabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				const enabled = runtime.ctx.session.isFastModeEnabled();
				runtime.ctx.showStatus(`Fast mode is ${enabled ? "on" : "off"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},

	{
		name: "artifact",
		description: "List, view, and clear session-scoped logs and outputs (artifacts)",
		acpDescription: "Manage session-scoped logs and outputs (artifacts)",
		acpInputHint: "[list|view <filename>|clear]",
		subcommands: [
			{ name: "list", description: "List all artifact files in this session" },
			{ name: "view", description: "View the content of an artifact file", usage: "<filename>" },
			{ name: "clear", description: "Delete all files in the artifacts directory" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const args = command.args.trim();
			const parts = args.split(/\s+/).filter(Boolean);
			const subcommand = parts[0]?.toLowerCase() || "list";
			const targetFile = parts.slice(1).join(" ");

			const dir = runtime.sessionManager.getArtifactsDir();
			if (!dir) {
				await runtime.output("No artifacts directory configured for this session.");
				return commandConsumed();
			}

			if (subcommand === "list") {
				try {
					const files = await fs.readdir(dir, { withFileTypes: true });
					const visibleFiles = files.filter(
						f => f.isFile() && !f.name.startsWith(".") && !f.name.endsWith(".metadata.json"),
					);
					if (visibleFiles.length === 0) {
						await runtime.output("No artifacts found.");
						return commandConsumed();
					}
					const listLines = [];
					for (const file of visibleFiles) {
						const stats = await fs.stat(path.join(dir, file.name));
						const sizeStr = `${(stats.size / 1024).toFixed(1)} KB`;
						listLines.push(`- ${file.name} (${sizeStr}) - Modified: ${stats.mtime.toLocaleString()}`);
					}
					await runtime.output(`Artifacts in this session:\n${listLines.join("\n")}`);
				} catch (err) {
					if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
						await runtime.output("No artifacts found.");
					} else {
						await runtime.output(`Error listing artifacts: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return commandConsumed();
			}

			if (subcommand === "view") {
				if (!targetFile) {
					return usage("Usage: /artifact view <filename>", runtime);
				}
				const filePath = path.join(dir, targetFile);
				if (!filePath.startsWith(path.resolve(dir))) {
					await runtime.output("Access denied: File must be inside the artifacts directory.");
					return commandConsumed();
				}
				try {
					const content = await fs.readFile(filePath, "utf8");
					await runtime.output(`--- Artifact: ${targetFile} ---\n${content}`);
				} catch (err) {
					await runtime.output(`Error reading artifact: ${err instanceof Error ? err.message : String(err)}`);
				}
				return commandConsumed();
			}

			if (subcommand === "clear") {
				try {
					const files = await fs.readdir(dir, { withFileTypes: true });
					let clearedCount = 0;
					for (const file of files) {
						if (file.isFile() && !file.name.startsWith(".") && !file.name.endsWith(".metadata.json")) {
							await fs.unlink(path.join(dir, file.name));
							const metaPath = path.join(dir, `${file.name}.metadata.json`);
							try {
								await fs.unlink(metaPath);
							} catch {
								// Ignore if no metadata exists
							}
							clearedCount++;
						}
					}
					await runtime.output(`Successfully cleared ${clearedCount} artifact file(s).`);
				} catch (err) {
					if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
						await runtime.output("Successfully cleared 0 artifact file(s).");
					} else {
						await runtime.output(`Error clearing artifacts: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return commandConsumed();
			}

			return usage("Usage: /artifact [list|view <filename>|clear]", runtime);
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleArtifactCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: "Export session to HTML file",
		inlineHint: "[path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: "Copy session transcript to clipboard",
		acpDescription: "Return full transcript as plain text",
		inlineHint: "[raw]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const isRaw = command.args.trim().toLowerCase() === "raw";
			const text = runtime.session.formatSessionAsText({ compact: !isRaw });
			await runtime.output(text || "No messages to dump yet.");
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const isRaw = command.args.trim().toLowerCase() === "raw";
			runtime.ctx.handleDumpCommand(isRaw);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "Share session as a secret GitHub gist",
		handle: async (_command, runtime) => {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				try {
					await runtime.session.exportToHtml(tmpFile);
				} catch (err) {
					return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
				}
				const result = await $`gh gist create --public=false ${tmpFile}`.quiet().nothrow();
				if (result.exitCode !== 0) {
					return usage(
						`Failed to create gist: ${result.stderr.toString("utf-8").trim() || "unknown error"}`,
						runtime,
					);
				}
				const gistUrl = result.stdout.toString("utf-8").trim();
				const gistId = gistUrl.split("/").pop();
				if (!gistId) return usage("Failed to parse gist ID from gh output", runtime);
				await runtime.output(`Share URL: https://gistpreview.github.io/?${gistId}\nGist: ${gistUrl}`);
				return commandConsumed();
			} catch {
				return usage("GitHub CLI (gh) is required for /share. Install it from https://cli.github.com/.", runtime);
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "browser",
		description: "Toggle browser headless vs visible mode",
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("Usage: /browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`Browser mode set to ${next ? "headless" : "visible"}, but restart failed: ${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`Failed to restart browser: ${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: "Copy last agent message to clipboard",
		subcommands: [
			{ name: "last", description: "Copy full last agent message" },
			{ name: "code", description: "Copy last code block" },
			{ name: "all", description: "Copy all code blocks from last message" },
			{ name: "cmd", description: "Copy last bash/python command" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || undefined;
			await runtime.ctx.handleCopyCommand(sub);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "Session management commands",
		acpDescription: "Show session information",
		acpInputHint: "info|delete",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args || command.args === "info") {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (command.args === "delete") {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		handle: async (_command, runtime) => {
			await runtime.output(await buildUsageReportText(runtime));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleUsageCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "changelog",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, 3);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(
				[...entriesToShow]
					.reverse()
					.map(entry => entry.content)
					.join("\n\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "Create a new fork from a previous message",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tan",
		description: "Run a full background agent on tangential work",
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work);
		},
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		handleTui: (_command, runtime) => {
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "Start a new session",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},

	{
		name: "handoff",
		description: "Hand off session context to a new session",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSessionSelector();
			runtime.ctx.editor.setText("");
		},
	},

	{
		name: "debug",
		description: "Open debug tools selector",
		handleTui: (_command, runtime) => {
			runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "omfg",
		description: "Forge a TTSR rule from a complaint to stop a recurring behavior",
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "Move session to a different working directory",
		acpDescription: "Move the current session file",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = path.resolve(runtime.cwd, command.args);
			let isDirectory: boolean;
			try {
				isDirectory = (await fs.stat(resolvedPath)).isDirectory();
			} catch {
				return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			}
			if (!isDirectory) return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			try {
				await runtime.sessionManager.flush();
				await runtime.sessionManager.moveTo(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args);
		},
	},
	{
		name: "exit",
		description: "Exit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "marketplace",
		description: "Browse, install, and manage marketplace extensions",
		acpDescription: "Browse and install marketplace extensions",
		acpInputHint: "[help|install|uninstall|discover|list]",
		customCompletions: getMarketplaceArgumentCompletions,
		subcommands: [
			{ name: "help", description: "Show marketplace usage information" },
			{
				name: "install",
				description: "Install a marketplace extension (TUI-only interactive picker)",
				usage: "[name@marketplace]",
			},
			{
				name: "uninstall",
				description: "Uninstall a marketplace extension (TUI-only interactive picker)",
				usage: "[name@marketplace]",
			},
			{ name: "discover", description: "Discover available marketplace extensions" },
			{ name: "list", description: "List installed marketplace extensions" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const runner = runtime.ctx.session.extensionRunner;
			const extCmd = runner?.getCommand("marketplace");
			if (extCmd) {
				await extCmd.handler(command.args, runner!.createCommandContext());
				return { consumed: true };
			}
			return undefined;
		},
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			const lines: string[] = [];
			switch (verb) {
				case "install":
				case "uninstall": {
					lines.push(`${verb}: TUI-only interactive picker. Use the TUI to ${verb} marketplace extensions.`);
					break;
				}
				case "discover": {
					const manager = await createMarketplaceManager(runtime);
					const discovered = await manager.listAvailablePlugins();
					if (discovered.length === 0) {
						lines.push("No marketplace extensions available.");
					} else {
						for (const ext of discovered) {
							lines.push(`  - ${ext.name}@${ext.version}: ${ext.description ?? ""}`);
						}
					}
					break;
				}
				case "list": {
					const manager = await createMarketplaceManager(runtime);
					const installed = await manager.listInstalledPlugins();
					if (installed.length === 0) {
						lines.push("No marketplace plugins installed.");
					} else {
						for (const plugin of installed) {
							const scope = plugin.scope === "project" ? " [project]" : "";
							const shadowed = plugin.shadowedBy ? " (shadowed)" : "";
							const disabled = plugin.entries.some(e => e.enabled === false) ? " (disabled)" : "";
							lines.push(`  ${plugin.id}${scope}${shadowed}${disabled}`);
						}
					}
					break;
				}
				default: {
					lines.push("Marketplace commands: help, install, uninstall, discover, list");
					lines.push("Usage: /marketplace [command]");
					lines.push("  help       Show this help text");
					lines.push("  install    Install a marketplace extension (TUI-only)");
					lines.push("  uninstall  Uninstall a marketplace extension (TUI-only)");
					lines.push("  discover   Discover available marketplace extensions");
					lines.push("  list       List installed marketplace extensions");
					break;
				}
			}
			for (const line of lines) runtime.output(line);
			return commandConsumed();
		},
	},
	{
		name: "plugins",
		description: "View and manage installed plugins",
		acpDescription: "Manage plugins",
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable a marketplace plugin", usage: "<name@marketplace>" },
			{ name: "disable", description: "Disable a marketplace plugin", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						`Usage: /plugins ${verb} [--scope user|project] <name@marketplace>`,
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push("npm plugins:");
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? " (disabled)" : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("marketplace plugins:");
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? " (disabled)" : "";
						const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? "No plugins installed" : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Plugin error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`Usage: /plugins ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push("npm plugins:");
							for (const p of npmPlugins) {
								const status = p.enabled === false ? " (disabled)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push("marketplace plugins:");
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? " (disabled)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus("No plugins installed");
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(`Plugin error: ${err}`);
			}
		},
	},
	{
		name: "reload-plugins",
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		acpDescription: "Reload all plugins",
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("Plugins reloaded.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			// Invalidate registry fs caches and the plugin roots cache so
			// listClaudePluginRoots re-reads from disk on next access.
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await runtime.ctx.refreshSlashCommandState();
			await runtime.ctx.session.refreshSshTool({ activateIfAvailable: true });
			runtime.ctx.showStatus("Plugins reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "ferment",
		description: "Ferment workflow commands",
		customCompletions: getFermentArgumentCompletions,
		subcommands: [
			{ name: "one-shot", description: "Create and auto-execute a single task ferment", usage: "<goal>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const args = command.args.trim();
			if (!args.startsWith("one-shot")) {
				return usage("Usage: /ferment one-shot <goal>", runtime);
			}
			const goal = args.slice("one-shot".length).trim();
			if (!goal) {
				return usage("Usage: /ferment one-shot <goal>", runtime);
			}

			// Create a draft ferment and use the state machine for proper lifecycle
			const now = new Date().toISOString();
			const draft: Ferment = {
				id: crypto.randomUUID(),
				name: "One-shot",
				status: "draft",
				goal,
				worktree: { path: runtime.cwd },
				scoping: {},
				phases: [],
				decisions: [],
				memories: [],
				createdAt: now,
				updatedAt: now,
			};
			const result = applyTransition(draft, {
				type: "oneShot",
				title: "One-shot",
				goal,
			});

			if ("error" in result) {
				return usage(`Failed to start one-shot ferment: ${result.error}`, runtime);
			}

			FermentStore.open().save(result);
			await runtime.output(`One-shot ferment started: "${goal}"`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			if (!args.startsWith("one-shot")) {
				const runner = runtime.ctx.session.extensionRunner;
				const extCmd = runner?.getCommand("ferment");
				if (extCmd) {
					await extCmd.handler(command.args, runner!.createCommandContext());
					return { consumed: true };
				}
				return undefined;
			}
			const goal = args.slice("one-shot".length).trim();
			if (!goal) {
				runtime.ctx.showStatus("Usage: /ferment one-shot <goal>");
				runtime.ctx.editor.setText("");
				return;
			}

			// Create a draft ferment and use the state machine for proper lifecycle
			const now = new Date().toISOString();
			const draft: Ferment = {
				id: crypto.randomUUID(),
				name: "One-shot",
				status: "draft",
				goal,
				worktree: { path: process.cwd() },
				scoping: {},
				phases: [],
				decisions: [],
				memories: [],
				createdAt: now,
				updatedAt: now,
			};
			const result = applyTransition(draft, {
				type: "oneShot",
				title: "One-shot",
				goal,
			});

			if ("error" in result) {
				runtime.ctx.showStatus(`Failed to start one-shot ferment: ${result.error}`);
				runtime.ctx.editor.setText("");
				return;
			}

			FermentStore.open().save(result);
			runtime.ctx.showStatus(`One-shot ferment started: "${goal}"`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "quit",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "schedule",
		description: "Create and manage scheduled agent runs",
		acpDescription: "Manage agent cron schedules",
		acpInputHint: "<subcommand>",
		subcommands: [
			{
				name: "create",
				description: "Create a new schedule",
				usage: "<name> --cron <pattern> --prompt <task> [--agent <agent>]",
			},
			{ name: "list", description: "List all schedules" },
			{ name: "delete", description: "Delete a schedule", usage: "<id>" },
			{ name: "pause", description: "Pause a schedule", usage: "<id>" },
			{ name: "resume", description: "Resume a schedule", usage: "<id>" },
			{ name: "trigger", description: "Trigger a schedule immediately", usage: "<id>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);

			if (verb === "list") {
				const schedules = globalScheduler.getSchedules();
				if (schedules.length === 0) {
					await runtime.output("No schedules found.");
					return commandConsumed();
				}
				const lines = schedules.map(
					s =>
						`- ${s.id}: ${s.name} (cron: ${s.cronPattern}) [${s.enabled ? "active" : "paused"}]\n  prompt: ${s.prompt}`,
				);
				await runtime.output(`Schedules:\n${lines.join("\\n")}`);
				return commandConsumed();
			}

			if (verb === "create") {
				const parts = rest.split(" --");
				const name = parts[0].trim();
				let cronPattern = "";
				let prompt = "";
				let agent;

				for (let i = 1; i < parts.length; i++) {
					const p = parts[i].trim();
					if (p.startsWith("cron ")) cronPattern = p.slice(5).trim();
					else if (p.startsWith("prompt ")) prompt = p.slice(7).trim();
					else if (p.startsWith("agent ")) agent = p.slice(6).trim();
				}

				if (!name || !cronPattern || !prompt) {
					return usage("Usage: /schedule create <name> --cron <pattern> --prompt <task>", runtime);
				}

				const run = globalScheduler.createSchedule({ name, cronPattern, prompt, agent });
				await runtime.output(`Schedule created: ${run.id} (${run.name})`);
				return commandConsumed();
			}

			if (verb === "delete") {
				const id = rest.trim();
				if (!id) return usage("Usage: /schedule delete <id>", runtime);
				const deleted = globalScheduler.deleteSchedule(id);
				await runtime.output(deleted ? `Schedule ${id} deleted.` : `Schedule ${id} not found.`);
				return commandConsumed();
			}

			if (verb === "pause") {
				const id = rest.trim();
				if (!id) return usage("Usage: /schedule pause <id>", runtime);
				const run = globalScheduler.pauseSchedule(id);
				await runtime.output(run ? `Schedule ${id} paused.` : `Schedule ${id} not found.`);
				return commandConsumed();
			}

			if (verb === "resume") {
				const id = rest.trim();
				if (!id) return usage("Usage: /schedule resume <id>", runtime);
				const run = globalScheduler.resumeSchedule(id);
				await runtime.output(run ? `Schedule ${id} resumed.` : `Schedule ${id} not found.`);
				return commandConsumed();
			}

			if (verb === "trigger") {
				const id = rest.trim();
				if (!id) return usage("Usage: /schedule trigger <id>", runtime);
				const success = await globalScheduler.triggerSchedule(id, runtime);
				await runtime.output(success ? `Schedule ${id} triggered.` : `Schedule ${id} not found.`);
				return commandConsumed();
			}

			runtime.output(
				'Usage: /schedule [create|list|delete|pause|resume|trigger]\n\nTip: To create a schedule, use:\n/schedule create "MyTask" --cron "0 9 * * *" --prompt "What do you want me to do?"',
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);

			if (verb === "list") {
				const schedules = globalScheduler.getSchedules();
				if (schedules.length === 0) {
					runtime.ctx.showStatus("No schedules found.");
					runtime.ctx.editor.setText("");
					return;
				}
				const lines = schedules.map(
					s =>
						`- ${s.id}: ${s.name} (cron: ${s.cronPattern}) [${s.enabled ? "active" : "paused"}]\n  prompt: ${s.prompt}`,
				);
				runtime.ctx.showStatus(`Schedules:\n${lines.join("\\n")}`);
				runtime.ctx.editor.setText("");
				return;
			}

			if (verb === "create") {
				const parts = rest.split(" --");
				const name = parts[0].trim();
				let cronPattern = "";
				let prompt = "";
				let agent;

				for (let i = 1; i < parts.length; i++) {
					const p = parts[i].trim();
					if (p.startsWith("cron ")) cronPattern = p.slice(5).trim();
					else if (p.startsWith("prompt ")) prompt = p.slice(7).trim();
					else if (p.startsWith("agent ")) agent = p.slice(6).trim();
				}

				if (!name || !cronPattern || !prompt) {
					runtime.ctx.showStatus("Fill out the schedule details below and hit Enter!");
					const template = `/schedule create MyTask --cron "0 9 * * 1-5" --prompt ""`;
					runtime.ctx.editor.setText(template);
					if (typeof runtime.ctx.editor.setCursorPosition === "function") {
						runtime.ctx.editor.setCursorPosition(0, template.length - 1);
					}
					return;
				}

				const run = globalScheduler.createSchedule({ name, cronPattern, prompt, agent });
				runtime.ctx.showStatus(`Schedule created: ${run.id} (${run.name})`);
				runtime.ctx.editor.setText("");
				return;
			}

			if (verb === "delete") {
				const id = rest.trim();
				if (!id) {
					runtime.ctx.showStatus("Usage: /schedule delete <id>");
					runtime.ctx.editor.setText("");
					return;
				}
				const deleted = globalScheduler.deleteSchedule(id);
				runtime.ctx.showStatus(deleted ? `Schedule ${id} deleted.` : `Schedule ${id} not found.`);
				runtime.ctx.editor.setText("");
				return;
			}

			if (verb === "pause") {
				const id = rest.trim();
				if (!id) {
					runtime.ctx.showStatus("Usage: /schedule pause <id>");
					runtime.ctx.editor.setText("");
					return;
				}
				const run = globalScheduler.pauseSchedule(id);
				runtime.ctx.showStatus(run ? `Schedule ${id} paused.` : `Schedule ${id} not found.`);
				runtime.ctx.editor.setText("");
				return;
			}

			if (verb === "resume") {
				const id = rest.trim();
				if (!id) {
					runtime.ctx.showStatus("Usage: /schedule resume <id>");
					runtime.ctx.editor.setText("");
					return;
				}
				const run = globalScheduler.resumeSchedule(id);
				runtime.ctx.showStatus(run ? `Schedule ${id} resumed.` : `Schedule ${id} not found.`);
				runtime.ctx.editor.setText("");
				return;
			}

			if (verb === "trigger") {
				const id = rest.trim();
				if (!id) {
					runtime.ctx.showStatus("Usage: /schedule trigger <id>");
					runtime.ctx.editor.setText("");
					return;
				}
				// We pass runtime.ctx to execute the background task properly
				const success = await globalScheduler.triggerSchedule(id, runtime.ctx);
				runtime.ctx.showStatus(success ? `Schedule ${id} triggered.` : `Schedule ${id} not found.`);
				runtime.ctx.editor.setText("");
				return;
			}

			if (!verb) {
				runtime.ctx.showStatus("Fill out the schedule details below and hit Enter!");
				const template = `/schedule create MyTask --cron "0 9 * * 1-5" --prompt ""`;
				runtime.ctx.editor.setText(template);
				if (typeof runtime.ctx.editor.setCursorPosition === "function") {
					runtime.ctx.editor.setCursorPosition(0, template.length - 1);
				}
				return;
			}

			runtime.ctx.showStatus("Usage: /schedule [create|list|delete|pause|resume|trigger]");
			runtime.ctx.editor.setText("");
		},
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: Set<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		customCompletions: command.customCompletions,
	}),
);

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<
	BuiltinSlashCommand & {
		getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
		getInlineHint?: (argumentText: string) => string | null;
	}
> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd => {
	if (cmd.subcommands) {
		const defaultCompletions = buildArgumentCompletions(cmd.subcommands);

		return {
			...cmd,
			argumentHint: "<subcommand>",
			getArgumentCompletions: (prefix: string) => {
				const res = cmd.customCompletions ? cmd.customCompletions(prefix) : null;
				return res || defaultCompletions(prefix);
			},
			getInlineHint: buildSubcommandInlineHint(cmd.subcommands),
		};
	}
	if (cmd.inlineHint) {
		return {
			...cmd,
			argumentHint: cmd.inlineHint,
			getInlineHint: buildStaticInlineHint(cmd.inlineHint),
		};
	}
	return cmd;
});

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshSlashCommandState();
				await ctx.session.refreshSshTool({ activateIfAvailable: true });
			},
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
