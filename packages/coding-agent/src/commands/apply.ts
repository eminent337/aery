import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import { runApplyCommand } from "../cli/apply-cli";

export default class Apply extends Command {
	static description = "Apply code changes from a previous agent session to current workspace";

	static aliases = ["a"];

	static args = {
		target: Args.string({
			description: "Session ID, prefix, or path to session JSONL file",
			required: false,
		}),
	};

	static flags = {
		last: Flags.boolean({
			char: "l",
			description: "Apply changes from the most recent session in this workspace",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "d",
			description: "Display unified diffs without modifying files on disk",
			default: false,
		}),
	};

	static examples = [
		"aery apply --last",
		"aery apply --last --dry-run",
		"aery apply sess_12345",
		"aery apply path/to/session.jsonl",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Apply);
		await runApplyCommand({
			target: args.target,
			last: flags.last,
			dryRun: flags["dry-run"],
		});
	}
}
