import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import { prepareExecArgs } from "../cli/exec-cli";
import { runRootCommand } from "../main";

export default class Exec extends Command {
	static description = "Run non-interactive headless agent execution matching codex exec";

	static aliases = ["e"];

	static strict = false;

	static args = {
		prompt: Args.string({
			description: "Prompt to execute headlessly",
			required: false,
		}),
	};

	static flags = {
		"output-last-message": Flags.string({
			char: "o",
			description: "File to write the final agent response message to",
		}),
		json: Flags.boolean({
			char: "j",
			description: "Format output as JSON stream or records",
			default: false,
		}),
		ephemeral: Flags.boolean({
			description: "Do not persist session to disk",
			default: false,
		}),
		"output-schema": Flags.string({
			description: "Path to JSON schema file for structured output",
		}),
		model: Flags.string({
			char: "m",
			description: "Model to use for this execution",
		}),
	};

	static examples = [
		"aery exec 'Summarize README.md'",
		"aery e -o output.txt 'Generate migration plan'",
		"aery exec --json 'List dependencies in package.json'",
		"aery exec --ephemeral 'Quick check on syntax'",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Exec);
		const { parsed, rawArgs } = prepareExecArgs(this.argv, {
			prompt: args.prompt,
			outputLastMessage: flags["output-last-message"],
			json: flags.json,
			ephemeral: flags.ephemeral,
			outputSchema: flags["output-schema"],
			model: flags.model,
		});

		await runRootCommand(parsed, rawArgs);
	}
}
