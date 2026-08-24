import { spawn } from "node:child_process";
import { join } from "node:path";
import { commandConsumed } from "./helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

async function runPluginCli(
	userArgs: readonly string[],
	io: { writeln: (t?: string) => Promise<void> | void; writeErr: (t: string) => Promise<void> | void },
	cwd: string,
): Promise<void> {
	// Aery's CLI entry point is at the root of the src directory relative to this file
	const cliPath = join(import.meta.dir, "..", "cli.ts");
	const args = ["run", cliPath, "plugin", ...userArgs];
	const isWindows = process.platform === "win32";

	await io.writeln(`Running: bun aery plugin ${userArgs.join(" ")}`);

	return new Promise<void>(resolve => {
		const child = spawn(process.execPath, args, {
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
			void io.writeErr(`Failed to run aery plugin: ${error.message}`);
			resolve();
		});

		child.once("close", () => {
			resolve();
		});
	});
}

export const pluginCommand: SlashCommandSpec = {
	name: "plugin",
	description: "Manage Aery plugins",
	allowArgs: true,
	subcommands: [
		{ name: "install", description: "Install a plugin" },
		{ name: "uninstall", description: "Uninstall a plugin" },
		{ name: "list", description: "List installed plugins" },
		{ name: "doctor", description: "Check plugin health" },
		{ name: "marketplace", description: "Manage marketplaces" },
	],
	handle: async (command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> => {
		const userArgs = command.args.trim().split(/\s+/).filter(Boolean);
		if (userArgs.length === 0) {
			await runtime.output(`Usage: /plugin <command> [options]`);
			return commandConsumed();
		}

		await runPluginCli(
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
		);

		await runtime.reloadPlugins();
		return commandConsumed();
	},
	handleTui: async (command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<SlashCommandResult> => {
		const userArgs = command.args.trim().split(/\s+/).filter(Boolean);
		if (userArgs.length === 0) {
			runtime.ctx.showPluginMarketplaceHub("marketplace");
			runtime.ctx.editor.setText("");
			return;
		}

		await runPluginCli(
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
		);

		runtime.ctx.editor.setText("");
		// Reload plugins so the agent sees new capabilities immediately
		await runtime.ctx.refreshSlashCommandState();
	},
};
