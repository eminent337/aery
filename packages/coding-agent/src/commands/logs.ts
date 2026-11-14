import { Args, Command, Flags } from "@aryee337/aery-utils/cli";
import chalk from "chalk";
import { findBackgroundSession, readBackgroundSessionLogs } from "../cli/daemon-session-manager";

export default class Logs extends Command {
	static description = "Print a background session's recent terminal output";

	static args = {
		id: Args.string({
			description: "Short session ID or prefix",
			required: true,
		}),
	};

	static flags = {
		lines: Flags.integer({
			char: "n",
			description: "Number of lines to output",
			default: 50,
		}),
	};

	static examples = ["aery logs abc1234", "aery logs abc1234 -n 100"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Logs);
		const session = await findBackgroundSession(args.id);
		if (!session) {
			console.error(chalk.red(`Error: No background session matching '${args.id}' found.`));
			process.exitCode = 1;
			return;
		}

		const output = await readBackgroundSessionLogs(session.id, flags.lines);
		console.log(output);
	}
}
