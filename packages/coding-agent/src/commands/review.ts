import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import { runReviewCommand } from "../cli/review-cli";

export default class Review extends Command {
	static description = "Review code changes non-interactively across working tree, branches, or commits";

	static args = {
		prompt: Args.string({
			description: "Optional custom review focus or instruction",
			required: false,
		}),
	};

	static flags = {
		uncommitted: Flags.boolean({
			char: "u",
			description: "Review uncommitted working tree changes (default)",
			default: true,
		}),
		base: Flags.string({
			char: "b",
			description: "Base branch to compare against HEAD (e.g. main)",
		}),
		commit: Flags.string({
			char: "c",
			description: "Specific commit hash to review",
		}),
		json: Flags.boolean({
			char: "j",
			description: "Output structured JSON report for CI/CD gates",
			default: false,
		}),
		title: Flags.string({
			char: "t",
			description: "Custom review title",
		}),
	};

	static examples = [
		"aery review",
		"aery review --base main",
		"aery review --commit abc1234",
		"aery review --json",
		'aery review "Focus on security and concurrency"',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Review);
		await runReviewCommand({
			prompt: args.prompt,
			uncommitted: flags.uncommitted,
			base: flags.base,
			commit: flags.commit,
			json: flags.json,
			title: flags.title,
		});
	}
}
