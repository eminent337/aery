import type { SlashCommand } from "@aryee337/aery-tui";
import { settings } from "../config/settings";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, BUILTIN_SLASH_COMMANDS } from "../slash-commands/builtin-registry";
import type { AgentSession } from "../session/agent-session";

export class SlashCommandResolver {
	constructor(
		private readonly session: AgentSession,
		private readonly extensionRunner?: ExtensionRunner,
	) {}

	resolveBuiltinCommands(): SlashCommand[] {
		return BUILTIN_SLASH_COMMANDS.map(cmd => ({ ...cmd, category: "builtin" as const }));
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
		const hookCommands: SlashCommand[] = (
			runner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
			category: "custom" as const,
		}));

		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
			category: "custom" as const,
		}));

		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				skillCommandList.push({
					name: commandName,
					description: skill.description,
					category: "skill" as const,
				});
			}
		}

		const fileCommands = preloadedFileCommands ?? (await this.resolveFileCommands(cwd));

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
