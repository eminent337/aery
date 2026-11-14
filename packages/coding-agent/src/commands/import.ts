import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import { printImportConsole, runImport } from "../cli/import-cli";

export default class Import extends Command {
	static description = "Import config, rules, and MCP servers from another AI coding agent into Aery";

	static args = {
		source: Args.string({
			description: "Agent source to import from: cursor, claude, codex, gemini (default: all)",
			required: false,
			options: ["cursor", "claude", "codex", "gemini", "all"],
		}),
	};

	static flags = {
		"dry-run": Flags.boolean({
			char: "n",
			description: "Scan and display importable items without writing files",
			default: false,
		}),
		json: Flags.boolean({
			char: "j",
			description: "Emit JSON result",
			default: false,
		}),
	};

	static examples = ["aery import", "aery import claude", "aery import cursor --dry-run", "aery import codex"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Import);
		const result = await runImport({
			source: args.source,
			dryRun: flags["dry-run"],
		});

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			printImportConsole(result);
		}
	}
}
