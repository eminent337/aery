import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import { runFeaturesCommand } from "../cli/features-cli";

export default class Features extends Command {
	static description = "Inspect and manage Aery platform runtime feature flags";

	static args = {
		action: Args.string({
			description: "list (default), enable, or disable",
			required: false,
			options: ["list", "enable", "disable"],
			default: "list",
		}),
		feature: Args.string({
			description: "Feature name (for enable/disable)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON output", default: false }),
	};

	static examples = [
		"aery features",
		"aery features list --json",
		"aery features enable code_mode",
		"aery features disable chronicle",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Features);
		await runFeaturesCommand(args.action, args.feature, { json: flags.json });
	}
}
