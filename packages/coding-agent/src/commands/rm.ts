import { Args, Command } from "@aryee337/aery-utils/cli";
import chalk from "chalk";
import { findBackgroundSession, removeBackgroundSession } from "../cli/daemon-session-manager";

export default class Rm extends Command {
	static description = "Remove a background agent session from the registry";

	static args = {
		id: Args.string({
			description: "Short session ID or prefix",
			required: true,
		}),
	};

	static examples = ["aery rm abc1234"];

	async run(): Promise<void> {
		const { args } = await this.parse(Rm);
		const session = await findBackgroundSession(args.id);
		if (!session) {
			console.error(chalk.red(`Error: No background session matching '${args.id}' found.`));
			process.exitCode = 1;
			return;
		}

		const removed = await removeBackgroundSession(session.id);
		if (removed) {
			console.log(chalk.green(`Removed session ${session.id}`));
		} else {
			console.error(chalk.red(`Failed to remove session ${session.id}`));
		}
	}
}
