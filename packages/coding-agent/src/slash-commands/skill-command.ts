import { spawn } from "node:child_process";
import { installedEndorsedSkillNames, renderEndorsedSkills } from "../skills/endorsed-catalog";
import { commandConsumed } from "./helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

const SKILLS_PACKAGE = "skills@latest";

const AERY_SCOPED_SUBCOMMANDS = new Set(["add", "install", "i", "update", "remove", "rm", "r", "uninstall"]);

const SKILLS_SUBCOMMAND_ALIASES = new Map([
	["install", "add"],
	["uninstall", "remove"],
]);

function hasAgentFlag(args: readonly string[]): boolean {
	return args.some(arg => arg === "-a" || arg === "--agent" || arg.startsWith("--agent="));
}

function optionConsumesNextValue(arg: string): boolean {
	return arg === "-a" || arg === "--agent";
}

function findSubcommandIndex(args: readonly string[]): number {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("-")) {
			if (optionConsumesNextValue(arg)) {
				index++;
			}
			continue;
		}
		return index;
	}
	return -1;
}

function findSubcommand(args: readonly string[]): string | undefined {
	const index = findSubcommandIndex(args);
	return index >= 0 ? args[index] : undefined;
}

function normalizeSkillsSubcommandAliases(args: string[]): void {
	const index = findSubcommandIndex(args);
	if (index < 0) return;
	const alias = SKILLS_SUBCOMMAND_ALIASES.get(args[index]);
	if (alias) {
		args[index] = alias;
	}
}

export function buildSkillsArgs(userArgs: readonly string[]): string[] {
	const args = [...userArgs];
	const subcommand = findSubcommand(args);
	normalizeSkillsSubcommandAliases(args);
	if (subcommand && AERY_SCOPED_SUBCOMMANDS.has(subcommand) && !hasAgentFlag(args)) {
		args.push("--agent", "aery");
	}
	return ["-y", SKILLS_PACKAGE, ...args];
}

async function runSkillCommand(
	userArgs: readonly string[],
	io: { writeln: (t?: string) => Promise<void> | void; writeErr: (t: string) => Promise<void> | void },
	cwd: string,
	installedSkills: readonly { name: string }[] = [],
): Promise<void> {
	const [subcommand, ..._] = userArgs;
	if (subcommand === "endorsed" || subcommand === "catalog" || subcommand === "recommended") {
		const installed = new Set(installedSkills.map(skill => skill.name));
		await io.writeln(renderEndorsedSkills(installedEndorsedSkillNames(installed)));
		return;
	}

	const args = buildSkillsArgs(userArgs);
	const isWindows = process.platform === "win32";

	await io.writeln(`Running: npx ${args.join(" ")}`);

	return new Promise<void>(resolve => {
		const child = spawn("npx", args, {
			cwd,
			stdio: "pipe",
			env: process.env,
			windowsHide: true,
			...(isWindows ? { shell: true } : {}),
		});

		child.stdout?.on("data", (data: Buffer) => {
			void io.writeln(data.toString().trimEnd());
		});

		child.stderr?.on("data", (data: Buffer) => {
			void io.writeErr(data.toString().trimEnd());
		});

		child.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				void io.writeErr('npx was not found. Install Node.js (which includes npx) to use "aery skill".');
			} else {
				void io.writeErr(`Failed to run npx ${SKILLS_PACKAGE}: ${error.message}`);
			}
			resolve();
		});

		child.once("close", () => {
			resolve();
		});
	});
}

export const skillCommand: SlashCommandSpec = {
	name: "skill",
	description: "Manage Aery skills",
	allowArgs: true,
	subcommands: [
		{ name: "install", description: "Install a skill" },
		{ name: "uninstall", description: "Uninstall a skill" },
		{ name: "list", description: "List installed skills" },
		{ name: "endorsed", description: "Show the endorsed skills catalog with install status" },
	],
	handle: async (command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> => {
		const userArgs = command.args.trim().split(/\s+/).filter(Boolean);
		if (userArgs.length === 0) {
			await runtime.output(`Usage: /skill <install|uninstall|list|endorsed> [options]`);
			return commandConsumed();
		}

		await runSkillCommand(
			userArgs,
			{
				writeln: async t => {
					if (t) {
						await runtime.output(t);
					}
				},
				writeErr: async t => await runtime.output(`Error: ${t}`),
			},
			runtime.cwd,
			runtime.session.skills,
		);

		return commandConsumed();
	},
	handleTui: async (command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<SlashCommandResult> => {
		const userArgs = command.args.trim().split(/\s+/).filter(Boolean);
		if (userArgs.length === 0) {
			runtime.ctx.showStatus(`Usage: /skill <install|uninstall|list> [options]`);
			runtime.ctx.editor.setText("/skill ");
			return;
		}

		await runSkillCommand(
			userArgs,
			{
				writeln: t => {
					if (t) {
						runtime.ctx.showStatus(t);
					}
				},
				writeErr: t => runtime.ctx.showStatus(`Error: ${t}`),
			},
			runtime.ctx.sessionManager.getCwd(),
			runtime.ctx.session.skills,
		);
		runtime.ctx.editor.setText("");
	},
};
