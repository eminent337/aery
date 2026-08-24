import type { SlashCommand } from "@aryee337/aery-tui";
import { settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { AgentSession } from "../session/agent-session";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, BUILTIN_SLASH_COMMANDS } from "../slash-commands/builtin-registry";

/**
 * Slash commands that are now driven autonomously by the AI agent through
 * their ai_* tool counterpart. They are hidden from the TUI prompt/autocomplete
 * so the user no longer has to type them — the agent invokes them itself
 * (with confirmation where required). They still execute if explicitly typed
 * and remain available to ACP clients via the shared registry.
 *
 * Kept visible (human-only): settings, hub, extensions, debug, hotkeys, tree,
 * branch, exit, quit, login, logout, model. Also kept: `plugin` and `skill`
 * (the Aery plugin CLI and skill launcher) since they have no ai_* wrapper.
 */
const TUI_HIDDEN_SLASH_COMMANDS: Record<string, true> = {
	advisor: true,
	artifact: true,
	autoresearch: true,
	autonomous: true,
	browser: true,
	btw: true,
	changelog: true,
	commit: true,
	"commit-push-pr": true,
	connect: true,
	copy: true,
	cron: true,
	diff: true,
	"dir-entry-ext": true,
	dump: true,
	eval: true,
	"eval-stats": true,
	export: true,
	fast: true,
	ferment: true,
	force: true,
	goal: true,
	green: true,
	handoff: true,
	loop: true,
	marketplace: true,
	mcp: true,
	move: true,
	omfg: true,
	plan: true,
	plugins: true,
	refine: true,
	rename: true,
	retry: true,
	review: true,
	schedule: true,
	session: true,
	shake: true,
	share: true,
	ssh: true,
	switch: true,
	tan: true,
	"thinking-steps": true,
	tools: true,
	usage: true,
	vim: true,
};

export class SlashCommandResolver {
	constructor(
		private readonly session: AgentSession,
		private readonly extensionRunner?: ExtensionRunner,
	) {}

	resolveBuiltinCommands(): SlashCommand[] {
		// Commands integrated as autonomous ai_* tools are hidden from the TUI
		// prompt/autocomplete — the AI agent invokes them instead, so the user
		// no longer has to type them. Only human-only commands stay visible.
		return BUILTIN_SLASH_COMMANDS.filter(cmd => !TUI_HIDDEN_SLASH_COMMANDS[cmd.name]).map(cmd => ({
			...cmd,
			category: "builtin" as const,
		}));
	}

	async resolveFileCommands(cwd: string): Promise<SlashCommand[]> {
		const fileCommands = await loadSlashCommands({ cwd });
		return fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
	}

	resolveTemplateCommands(reserved: Set<string>): SlashCommand[] {
		return this.session.promptTemplates
			.filter(template => !reserved.has(template.name))
			.map(template => ({
				name: template.name,
				description: template.description,
			}));
	}

	async resolveAllForAutocomplete(cwd: string, preloadedFileCommands?: SlashCommand[]): Promise<SlashCommand[]> {
		const builtins = this.resolveBuiltinCommands();

		const runner = this.extensionRunner ?? this.session.extensionRunner;
		const hookCommands: SlashCommand[] = (runner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? [])
			.filter(cmd => !TUI_HIDDEN_SLASH_COMMANDS[cmd.name])
			.map(cmd => ({
				name: cmd.name,
				description: cmd.description ?? "(hook command)",
				getArgumentCompletions: cmd.getArgumentCompletions,
				category: "custom" as const,
			}));

		const customCommands: SlashCommand[] = this.session.customCommands
			.filter(loaded => !TUI_HIDDEN_SLASH_COMMANDS[loaded.command.name])
			.map(loaded => ({
				name: loaded.command.name,
				description: `${loaded.command.description} (${loaded.source})`,
				category: "custom" as const,
			}));

		const skillCommandList: SlashCommand[] = [];
		let enableSkills = true;
		try {
			enableSkills = !!settings.get("skills.enableSkillCommands");
		} catch {
			enableSkills = true;
		}
		if (enableSkills) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				skillCommandList.push({
					name: commandName,
					description: skill.description,
					category: "skill" as const,
				});
			}
		}

		const fileCommands = (preloadedFileCommands ?? (await this.resolveFileCommands(cwd))).filter(
			cmd => !TUI_HIDDEN_SLASH_COMMANDS[cmd.name],
		);

		const reservedNames = new Set<string>([
			...builtins.map(cmd => cmd.name),
			...hookCommands.map(cmd => cmd.name),
			...customCommands.map(cmd => cmd.name),
			...skillCommandList.map(cmd => cmd.name),
			...fileCommands.map(cmd => cmd.name),
		]);

		const templateCommands = this.resolveTemplateCommands(reservedNames);

		return [
			...builtins,
			...hookCommands,
			...customCommands,
			...skillCommandList,
			...fileCommands.map(cmd => ({ ...cmd, category: "file" as const })),
			...templateCommands.map(cmd => ({ ...cmd, category: "template" as const })),
		];
	}
}
