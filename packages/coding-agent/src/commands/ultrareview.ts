import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import { printUltraReviewConsole, runUltraReview } from "../cli/ultrareview-cli";

export default class Ultrareview extends Command {
	static description = "Run an autonomous multi-agent code review of the current branch or target";

	static aliases = ["ur"];

	static args = {
		target: Args.string({
			description: "Target branch, base ref (e.g. main), or commit to compare against (default: HEAD)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({
			char: "j",
			description: "Print raw bugs/findings JSON payload instead of formatted text",
			default: false,
		}),
		output: Flags.string({
			char: "o",
			description: "Output file path to save findings (JSON or markdown)",
		}),
		"review-md": Flags.string({
			description: "Output markdown report file path",
		}),
		timeout: Flags.integer({
			description: "Maximum minutes to allow for review processing",
			default: 15,
		}),
		post: Flags.boolean({
			description: "Post the finished review findings to PR",
			default: false,
		}),
		"trust-workspace": Flags.boolean({
			description: "Trust current folder for this review run without prompts",
			default: true,
		}),
	};

	static examples = [
		"aery ultrareview",
		"aery ultrareview main",
		"aery ultrareview --json",
		"aery ultrareview HEAD~1 --review-md review.md",
		"aery ultrareview origin/main --output findings.json --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ultrareview);
		const result = await runUltraReview({
			target: args.target,
			json: flags.json,
			output: flags.output,
			reviewMd: flags["review-md"],
			timeout: flags.timeout,
			post: flags.post,
			trustWorkspace: flags["trust-workspace"],
		});

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			printUltraReviewConsole(result);
		}
	}
}
