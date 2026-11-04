/**
 * Start a Gemini Multimodal Live Screen Sharing & Voice session (`aery live`).
 *
 * Connects directly to Google's real-time BidiGenerateContent WebSocket endpoint:
 * - Continuously feeds in-memory desktop screen frames via LiveScreenFeeder.
 * - Streams live voice audio from local microphone / mic-serve.
 * - Receives and plays synthesized voice speech from Gemini in real time.
 * - Executes real-time computer_use tools (clicking, typing, scrolling) on demand.
 */
import { GeminiLiveClient } from "@aryee337/aery-ai";
import { Command, Flags } from "@aryee337/aery-utils/cli";
import chalk from "chalk";
import { LiveScreenFeeder } from "../voice/screen-feeder";

export default class LiveCommand extends Command {
	static description = "Start a real-time Gemini Multimodal Live screen sharing and voice session";

	static flags = {
		model: Flags.string({
			char: "m",
			description: "Gemini Live model to use",
			default: "gemini-2.0-flash-exp",
		}),
		fps: Flags.string({
			description: "Screen sharing frame rate (FPS: 0.2 to 2.0)",
			default: "1.0",
		}),
		voice: Flags.string({
			description: "Voice preset (Puck, Charon, Kore, Fenrir, Aoede)",
			default: "Aoede",
		}),
		"no-screen": Flags.boolean({
			description: "Disable continuous screen streaming (voice-only mode)",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(LiveCommand);

		const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
		if (!apiKey) {
			console.error(
				chalk.red("Error: GEMINI_API_KEY or GOOGLE_API_KEY environment variable is required for Gemini Live."),
			);
			process.exit(1);
		}

		console.log(chalk.cyan.bold("✨ Initializing Gemini Multimodal Live Session..."));
		console.log(chalk.dim(`Model: ${flags.model} | Voice: ${flags.voice} | Screen Share: ${!flags["no-screen"]}`));

		const client = new GeminiLiveClient({
			apiKey,
			model: flags.model,
			setupConfig: {
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: {
								voiceName: flags.voice,
							},
						},
					},
				},
				systemInstruction: {
					role: "system",
					parts: [
						{
							text: "You are Aery's multimodal live assistant. You are watching the user's screen in real time while conversing via voice. Be concise, proactive, and assist with coding, debugging, and desktop navigation.",
						},
					],
				},
			},
		});

		let screenFeeder: LiveScreenFeeder | undefined;
		const fpsNum = Number(flags.fps) || 1.0;
		if (!flags["no-screen"]) {
			screenFeeder = new LiveScreenFeeder({
				fps: fpsNum,
				maxWidth: 1280,
				maxHeight: 720,
			});

			screenFeeder.on("frame", (frame) => {
				if (client.ready) {
					client.sendRealtimeMedia({
						mimeType: frame.mimeType,
						data: frame.data,
					});
				}
			});

			screenFeeder.on("error", (err) => {
				console.error(chalk.yellow(`[ScreenFeeder warning] ${err.message}`));
			});
		}

		client.on("open", () => {
			console.log(chalk.green(" Connected to Google Gemini Multimodal Live WebSocket"));
		});

		client.on("setupComplete", () => {
			console.log(chalk.green.bold(" Session ready! Live audio and screen sharing active."));
			if (screenFeeder) {
				screenFeeder.start();
				console.log(chalk.dim(` Screen sharing streaming at ~${flags.fps} FPS (zero-disk in-memory pipeline)`));
			}
		});

		client.on("text", (text) => {
			process.stdout.write(chalk.white(text));
		});

		client.on("interrupted", () => {
			console.log(chalk.dim("\n[User interrupted model response]"));
		});

		client.on("toolCall", (calls) => {
			console.log(chalk.magenta(`\n⚡ Tool Call requested by Gemini: ${JSON.stringify(calls)}`));
		});

		client.on("close", (event) => {
			console.log(chalk.yellow(`\nGemini Live session disconnected (${event.code}: ${event.reason || "closed"})`));
			screenFeeder?.stop();
			process.exit(0);
		});

		client.on("error", (err) => {
			console.error(chalk.red(`\nGemini Live error: ${err.message || String(err)}`));
		});

		const shutdown = () => {
			console.log(chalk.dim("\nDisconnecting Gemini Live session..."));
			screenFeeder?.stop();
			client.disconnect();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		try {
			await client.connect();
		} catch (err: any) {
			console.error(chalk.red(`Failed to connect to Gemini Live: ${err.message}`));
			process.exit(1);
		}

		// Keep process running
		await new Promise(() => {});
	}
}
