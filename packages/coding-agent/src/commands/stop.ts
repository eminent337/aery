import { Args, Command } from "@aryee337/aery-utils/cli";
import chalk from "chalk";
import { findBackgroundSession, stopBackgroundSession } from "../cli/daemon-session-manager";

export default class Stop extends Command {
	static description = "Stop a running background agent session";

	static aliases = ["kill"];

	static args = {
		id: Args.string({
			description: "Short session ID or prefix",
			required: true,
		}),
	};

	static examples = ["aery stop abc1234"];

	async run(): Promise<void> {
		const { args } = await this.parse(Stop);
		const session = await findBackgroundSession(args.id);
		if (!session) {
			console.error(chalk.red(`Error: No background session matching '${args.id}' found.`));
			process.exitCode = 1;
			return;
		}

		const stopped = await stopBackgroundSession(session.id);
		if (stopped) {
			console.log(chalk.green(`Stopped background session: ${session.id}`));
		} else {
			console.log(chalk.yellow(`Session ${session.id} is already stopped.`));
		}
	}
}
