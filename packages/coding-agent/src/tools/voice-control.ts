/**
 * Voice Control & Audio Companion Tool for Aerys.
 *
 * Provides local real-time text-to-speech (Piper) and microphone
 * speech-to-text (Whisper.cpp) with interruption handling.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";
import { defaultVoiceEngine } from "../voice/voice-engine";
import { defaultVoiceDaemon } from "../voice/voice-daemon";

const voiceControlSchema = z.object({
	action: z
		.enum(["speak", "listen", "stop", "list_voices", "start_ambient", "stop_ambient", "ambient_status"])
		.describe(
			"Action: 'speak' synthesizes text to speech, 'listen' records a single utterance, 'stop' halts speech playback, 'list_voices' lists voice models, 'start_ambient' starts hands-free background microphone listening, 'stop_ambient' stops ambient listening, 'ambient_status' queries listening state.",
		),
	text: z.string().optional().describe("Text for Aerys to speak out loud when action is 'speak'."),
	voice: z
		.string()
		.optional()
		.describe("Voice model name (e.g. 'en_US-lessac-medium', 'en_US-amy-medium', 'en_GB-alan-medium')."),
	duration: z
		.number()
		.int()
		.optional()
		.describe("Recording duration in seconds for action 'listen' (default: 4 seconds)."),
});

export type VoiceControlParams = z.infer<typeof voiceControlSchema>;

export class VoiceControlTool implements AgentTool<typeof voiceControlSchema> {
	readonly name = "voice_control";
	readonly approval = "read" as const;
	readonly label = "Voice Control";
	readonly description =
		"Aerys real-time local voice companion tool. Speak out loud through speakers using local neural TTS (Piper), listen to microphone audio with local Whisper speech recognition, and handle barge-in interruptions.";
	readonly parameters = voiceControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Voice speech synthesis and microphone transcription (speak, listen, stop)";

	static createIf(_session: ToolSession): VoiceControlTool | null {
		return new VoiceControlTool();
	}

	async execute(_id: string, params: VoiceControlParams): Promise<AgentToolResult> {
		switch (params.action) {
			case "speak": {
				if (!params.text) {
					return {
						content: [{ type: "text", text: "Error: 'text' parameter is required for action 'speak'." }],
						details: { error: "missing_text" },
					};
				}

				if (!defaultVoiceEngine.isReady()) {
					return {
						content: [{ type: "text", text: "Voice engine binaries or models are not yet initialized." }],
						details: { error: "engine_not_ready" },
					};
				}

				try {
					const result = await defaultVoiceEngine.speak(params.text, { voice: params.voice });
					// Clean up temporary audio file after playback
					try {
						if (fs.existsSync(result.audioPath)) fs.rmSync(result.audioPath, { force: true });
					} catch {}

					const status = result.interrupted ? " (interrupted by user)" : " (completed)";
					return {
						content: [{ type: "text", text: `Spoke: "${params.text}"${status}` }],
						details: { text: params.text, interrupted: result.interrupted },
					};
				} catch (err: unknown) {
					const error = err as Error;
					return {
						content: [{ type: "text", text: `Speech synthesis failed: ${error.message}` }],
						details: { error: error.message },
					};
				}
			}

			case "listen": {
				if (!defaultVoiceEngine.isReady()) {
					return {
						content: [{ type: "text", text: "Voice engine binaries or models are not yet initialized." }],
						details: { error: "engine_not_ready" },
					};
				}

				try {
					const duration = params.duration ?? 4;
					const result = await defaultVoiceEngine.listen({ durationSeconds: duration });
					try {
						if (fs.existsSync(result.audioPath)) fs.rmSync(result.audioPath, { force: true });
					} catch {}

					const transcribed = result.text.trim();
					return {
						content: [
							{
								type: "text",
								text: transcribed ? `Heard from microphone: "${transcribed}"` : "(No speech detected on microphone)",
							},
						],
						details: { text: transcribed, durationMs: result.durationMs },
					};
				} catch (err: unknown) {
					const error = err as Error;
					return {
						content: [{ type: "text", text: `Audio transcription failed: ${error.message}` }],
						details: { error: error.message },
					};
				}
			}

			case "stop": {
				defaultVoiceEngine.stopSpeaking();
				return {
					content: [{ type: "text", text: "Stopped audio playback." }],
					details: { stopped: true },
				};
			}

			case "list_voices": {
				const modelsDir = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models");
				let voices: string[] = [];
				try {
					if (fs.existsSync(modelsDir)) {
						voices = fs
							.readdirSync(modelsDir)
							.filter(f => f.endsWith(".onnx"))
							.map(f => f.replace(/\.onnx$/, ""));
					}
				} catch {}

				return {
					content: [
						{
							type: "text",
							text: `Available Local Voices (${voices.length}):\n${voices.map(v => `- ${v}${v === defaultVoiceEngine.defaultVoice ? " (DEFAULT)" : ""}`).join("\n")}`,
						},
					],
					details: { voices, default: defaultVoiceEngine.defaultVoice },
				};
			}

			case "start_ambient": {
				const started = defaultVoiceDaemon.start();
				return {
					content: [
						{
							type: "text",
							text: started
								? "Aerys ambient voice listener started. I am now listening hands-free for your voice."
								: "Aerys ambient voice listener is already running.",
						},
					],
					details: defaultVoiceDaemon.getStatus(),
				};
			}

			case "stop_ambient": {
				const stopped = defaultVoiceDaemon.stop();
				return {
					content: [
						{
							type: "text",
							text: stopped
								? "Aerys ambient voice listener stopped."
								: "Aerys ambient voice listener was not active.",
						},
					],
					details: defaultVoiceDaemon.getStatus(),
				};
			}

			case "ambient_status": {
				const status = defaultVoiceDaemon.getStatus();
				return {
					content: [
						{
							type: "text",
							text: `Ambient Listener Status: ${status.running ? "ACTIVE" : "INACTIVE"}${status.recordingUtterance ? " (detecting speech)" : ""}`,
						},
					],
					details: status,
				};
			}
		}
	}
}
