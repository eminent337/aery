import chalk from "chalk";
import { VERSION } from "../config.js";
import type { AgentSession } from "../core/agent-session.js";
import type { AgentSessionServices } from "../core/agent-session-services.js";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";

const BUILT_IN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface CapabilitiesReport {
	version: string;
	cwd: string;
	currentModel?: {
		provider: string;
		id: string;
		thinkingLevel: string;
		supportsImages: boolean;
		supportsThinking: boolean;
	};
	providers: {
		total: number;
		configured: string[];
	};
	models: {
		total: number;
		available: number;
	};
	tools: {
		builtIn: string[];
		active: string[];
		registered: string[];
	};
	commands: {
		builtIn: string[];
		extension: string[];
		prompt: string[];
		skill: string[];
	};
	resources: {
		extensions: number;
		extensionNames: string[];
		extensionErrors: number;
		extensionLoadErrors: Array<{ path: string; error: string }>;
		skills: number;
		prompts: number;
		themes: number;
		contextFiles: number;
	};
	session: {
		persisted: boolean;
		sessionId?: string;
		messages: number;
		toolCalls: number;
		contextPercent?: number | null;
	};
}

export interface CollectCapabilitiesOptions {
	session: AgentSession;
	services: AgentSessionServices;
	version?: string;
}

function formatList(values: string[]): string {
	return values.length > 0 ? values.join(", ") : "none";
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function formatExtensionName(extensionPath: string): string {
	const coreMarker = "/core/";
	const coreIndex = extensionPath.lastIndexOf(coreMarker);
	const raw =
		coreIndex >= 0
			? extensionPath.slice(coreIndex + coreMarker.length)
			: (extensionPath.split("/").pop() ?? extensionPath);
	return raw.replace(/\.ts$/, "");
}

export function collectCapabilitiesReport(options: CollectCapabilitiesOptions): CapabilitiesReport {
	const { session, services } = options;
	const model = session.model;
	const allModels = services.modelRegistry.getAll();
	const availableModels = services.modelRegistry.getAvailable();
	const providers = [...new Set(allModels.map((item) => item.provider))].sort();
	const configuredProviders = providers
		.filter((provider) => services.modelRegistry.getProviderAuthStatus(provider).configured)
		.sort();

	const extensionsResult = services.resourceLoader.getExtensions();
	const extensionNames = extensionsResult.extensions.map((extension) => formatExtensionName(extension.path)).sort();
	const extensionCommands = extensionsResult.extensions.flatMap((extension) => Array.from(extension.commands.keys()));
	const extensionTools = extensionsResult.extensions.flatMap((extension) => Array.from(extension.tools.keys()));
	const promptCommands = services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name);
	const skillCommands = services.resourceLoader.getSkills().skills.map((skill) => `skill:${skill.name}`);
	const stats = session.getSessionStats();

	return {
		version: options.version ?? VERSION,
		cwd: services.cwd,
		currentModel: model
			? {
					provider: model.provider,
					id: model.id,
					thinkingLevel: session.thinkingLevel,
					supportsImages: model.input.includes("image"),
					supportsThinking: !!model.reasoning,
				}
			: undefined,
		providers: {
			total: providers.length,
			configured: configuredProviders,
		},
		models: {
			total: allModels.length,
			available: availableModels.length,
		},
		tools: {
			builtIn: Array.from(BUILT_IN_TOOL_NAMES),
			active: session.getActiveToolNames(),
			registered: [...new Set([...session.getAllTools().map((tool) => tool.name), ...extensionTools])].sort(),
		},
		commands: {
			builtIn: BUILTIN_SLASH_COMMANDS.map((command) => command.name),
			extension: [...new Set(extensionCommands)].sort(),
			prompt: [...new Set(promptCommands)].sort(),
			skill: [...new Set(skillCommands)].sort(),
		},
		resources: {
			extensions: extensionsResult.extensions.length,
			extensionNames,
			extensionErrors: extensionsResult.errors.length,
			extensionLoadErrors: extensionsResult.errors,
			skills: services.resourceLoader.getSkills().skills.length,
			prompts: services.resourceLoader.getPrompts().prompts.length,
			themes: services.resourceLoader.getThemes().themes.length,
			contextFiles: services.resourceLoader.getAgentsFiles().agentsFiles.length,
		},
		session: {
			persisted: stats.sessionFile !== undefined,
			sessionId: stats.sessionId,
			messages: stats.totalMessages,
			toolCalls: stats.toolCalls,
			contextPercent: stats.contextUsage?.percent,
		},
	};
}

export function formatCapabilitiesReport(report: CapabilitiesReport): string {
	const lines: string[] = [];
	lines.push(chalk.bold("Aery Capabilities"));
	lines.push("");
	lines.push(chalk.bold("Runtime"));
	lines.push(`  version: ${report.version}`);
	lines.push(`  cwd: ${report.cwd}`);
	if (report.currentModel) {
		const model = report.currentModel;
		const traits = [
			model.supportsImages ? "images" : "text-only",
			model.supportsThinking ? "reasoning" : "no reasoning",
		].join(", ");
		lines.push(`  current: ${model.provider}/${model.id}`);
		lines.push(`  thinking: ${model.thinkingLevel}`);
		lines.push(`  model traits: ${traits}`);
	} else {
		lines.push("  current: no model selected");
	}

	lines.push("");
	lines.push(chalk.bold("Built-In Tools"));
	lines.push(`  available: ${formatList(report.tools.builtIn)}`);
	lines.push(`  active: ${formatList(report.tools.active)}`);
	lines.push(`  registered: ${formatList(report.tools.registered)}`);

	lines.push("");
	lines.push(chalk.bold("Commands And Resources"));
	lines.push(
		`  commands: ${report.commands.builtIn.length} built-in, ${report.commands.extension.length} extension, ${report.commands.prompt.length} prompt, ${report.commands.skill.length} skill`,
	);
	lines.push(`  built-in commands: ${formatList(report.commands.builtIn)}`);
	lines.push(
		`  extensions: ${report.resources.extensions} loaded, ${report.resources.extensionErrors} ${report.resources.extensionErrors === 1 ? "error" : "errors"}`,
	);
	lines.push(`  loaded extensions: ${formatList(report.resources.extensionNames)}`);
	for (const error of report.resources.extensionLoadErrors) {
		lines.push(`  extension error: ${error.path}: ${error.error}`);
	}
	lines.push(
		`  resources: ${countLabel(report.resources.skills, "skill")}, ${countLabel(report.resources.prompts, "prompt")}, ${countLabel(report.resources.themes, "theme")}, ${countLabel(report.resources.contextFiles, "context file")}`,
	);

	lines.push("");
	lines.push(chalk.bold("Models And Providers"));
	lines.push(`  providers: ${report.providers.total} known`);
	lines.push(`  configured: ${formatList(report.providers.configured)}`);
	lines.push(`  models: ${report.models.available} available of ${report.models.total} known`);

	lines.push("");
	lines.push(chalk.bold("Session Intelligence"));
	lines.push(
		`  session: ${report.session.persisted ? "persisted" : "ephemeral"}${report.session.sessionId ? ` ${report.session.sessionId}` : ""}`,
	);
	lines.push(`  messages: ${report.session.messages}`);
	lines.push(`  tool calls: ${report.session.toolCalls}`);
	if (report.session.contextPercent !== undefined) {
		lines.push(
			`  context: ${report.session.contextPercent === null ? "unknown after compaction" : `${report.session.contextPercent.toFixed(1)}%`}`,
		);
	}
	lines.push("  supports: resume, fork, clone, tree navigation, import, export, share, compaction, branch summaries");

	lines.push("");
	lines.push(chalk.bold("Self-Extension"));
	lines.push("  dynamic tool registration: supported through the runtime tool API");
	lines.push("  tool authoring: supported with built-in read/write/edit/bash plus reloadable resources");
	lines.push("  subagent delegation: supported by the bundled subagent extension with isolated aery processes");
	lines.push("  automation modes: interactive, print, JSON, and RPC");

	return lines.join("\n");
}

export async function runCapabilitiesCommand(args: string[], options: CollectCapabilitiesOptions): Promise<boolean> {
	if (args[0] !== "capabilities") {
		return false;
	}

	const report = collectCapabilitiesReport(options);
	if (args.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatCapabilitiesReport(report));
	}
	return true;
}
