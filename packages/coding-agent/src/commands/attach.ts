import { Args, Command } from "@aryee337/aery-utils/cli";
import chalk from "chalk";
import { findBackgroundSession, readBackgroundSessionLogs } from "../cli/daemon-session-manager";

export default class Attach extends Command {
	static description = "Attach to a background agent session or view its current activity";

	static args = {
		id: Args.string({
			description: "Short session ID or prefix to attach to",
			required: true,
		}),
	};

	static examples = ["aery attach abc1234"];

	async run(): Promise<void> {
		const { args } = await this.parse(Attach);
		const session = await findBackgroundSession(args.id);
		if (!session) {
			console.error(chalk.red(`Error: No background session matching '${args.id}' found.`));
			process.exitCode = 1;
			return;
		}

		console.log(chalk.bold(`Attaching to session: ${session.id} (PID ${session.pid})`));
		console.log(chalk.dim(`Directory: ${session.cwd}`));
		console.log(chalk.dim(`Status: ${session.status}\n`));

		const logs = await readBackgroundSessionLogs(session.id, 40);
		console.log(logs);
	}
}
