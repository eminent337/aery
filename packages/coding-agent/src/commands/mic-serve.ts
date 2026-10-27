/**
 * Serve this machine's microphone / audio streaming daemon (`aery mic-serve`).
 */
import { Command, Flags } from "@aryee337/aery-utils/cli";
import chalk from "chalk";
import { MicServer } from "../voice/webrtc-serve";

export default class MicServe extends Command {
	static description = "Serve real-time audio stream server for remote microphone companion input";

	static flags = {
		port: Flags.integer({
			char: "p",
			description: "Port to listen on",
			default: 8766,
		}),
		token: Flags.string({
			char: "t",
			description: "Optional security token required for client connections",
		}),
		rate: Flags.integer({
			char: "r",
			description: "Audio sample rate in Hz",
			default: 16000,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(MicServe);

		const server = new MicServer({
			port: flags.port,
			token: flags.token,
			sampleRate: flags.rate,
		});

		await server.start();

		console.log(chalk.green(`🎤 Aery MicServe audio daemon listening on port ${flags.port}`));
		console.log(
			chalk.dim(`Status: http://localhost:${flags.port}/status${flags.token ? `?token=${flags.token}` : ""}`),
		);
		console.log(
			chalk.dim(`Stream: ws://localhost:${flags.port}/ws/audio${flags.token ? `?token=${flags.token}` : ""}`),
		);
		console.log(chalk.cyan("Press Ctrl+C to terminate the audio daemon."));

		const shutdown = async () => {
			console.log(chalk.dim("\nShutting down audio daemon..."));
			await server.stop();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		// Keep process alive
		await new Promise(() => {});
	}
}
