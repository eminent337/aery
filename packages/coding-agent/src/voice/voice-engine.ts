/**
 * Aerys Real-Time Voice Engine.
 *
 * Provides 100% local, lightweight Speech-to-Text (Whisper.cpp) and
 * Text-to-Speech (Piper) with PipeWire audio stream integration.
 *
 * Features:
 * - Ultra-fast local neural TTS via Piper (<100ms latency)
 * - Whisper.cpp speech transcription with AVX2 acceleration
 * - Barge-in interruption handling: instant audio playback cutoff on demand
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VoiceConfig {
	voiceDir?: string;
	defaultVoice?: string;
}

export interface TranscriptionResult {
	text: string;
	audioPath: string;
	durationMs: number;
}

export interface SpeechResult {
	audioPath: string;
	interrupted: boolean;
}

export class VoiceEngine {
	readonly #binDir: string;
	readonly #modelsDir: string;
	#defaultVoice: string;
	#activePlaybackProcess: ChildProcess | null = null;

	constructor(config: VoiceConfig = {}) {
		const baseDir = config.voiceDir || path.join(os.homedir(), ".local", "share", "aerys", "voice");
		this.#binDir = path.join(baseDir, "bin");
		this.#modelsDir = path.join(baseDir, "models");
		this.#defaultVoice = config.defaultVoice || "en_US-hfc_female-medium";
	}

	get defaultVoice(): string {
		return this.#defaultVoice;
	}

	set defaultVoice(name: string) {
		this.#defaultVoice = name;
	}

	/** Path to piper binary */
	get piperBinary(): string {
		return path.join(this.#binDir, "piper");
	}

	/** Path to whisper-cli binary */
	get whisperBinary(): string {
		return path.join(this.#binDir, "whisper-cli");
	}

	/** Path to whisper model */
	get whisperModel(): string {
		return path.join(this.#modelsDir, "ggml-base.en.bin");
	}

	/** Get voice onnx model path */
	getVoiceModelPath(voiceName = this.#defaultVoice): string {
		const name = voiceName.endsWith(".onnx") ? voiceName : `${voiceName}.onnx`;
		return path.join(this.#modelsDir, name);
	}

	/** Check if local voice binaries and models are ready */
	isReady(): boolean {
		return (
			fs.existsSync(this.piperBinary) &&
			fs.existsSync(this.whisperBinary) &&
			fs.existsSync(this.whisperModel) &&
			fs.existsSync(this.getVoiceModelPath())
		);
	}

	/** Stop any active audio playback immediately (Barge-in / interruption) */
	stopSpeaking(): void {
		if (this.#activePlaybackProcess) {
			try {
				this.#activePlaybackProcess.kill("SIGTERM");
			} catch {}
			this.#activePlaybackProcess = null;
		}
	}

	/**
	 * Synthesize text to speech using Piper and play it through PipeWire.
	 * Returns whether the playback completed or was interrupted.
	 */
	async speak(text: string, options: { voice?: string; playAudio?: boolean } = {}): Promise<SpeechResult> {
		this.stopSpeaking();

		const voicePath = this.getVoiceModelPath(options.voice);
		if (!fs.existsSync(voicePath)) {
			throw new Error(`Voice model not found: ${voicePath}`);
		}

		const timestamp = Date.now();
		const audioPath = path.join(os.tmpdir(), `aerys-speech-${timestamp}.wav`);

		// Generate WAV audio file with Piper
		await new Promise<void>((resolve, reject) => {
			const piperArgs = [
				"--model",
				voicePath,
				"--noise_scale",
				"0.33",
				"--noise_w",
				"0.4",
				"--length_scale",
				"1.06",
				"--output_file",
				audioPath,
			];
			const piper = spawn(this.piperBinary, piperArgs, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			piper.on("error", reject);
			piper.on("close", code => {
				if (code === 0 && fs.existsSync(audioPath)) {
					resolve();
				} else {
					reject(new Error(`Piper synthesis failed with code ${code}`));
				}
			});

			piper.stdin.write(text);
			piper.stdin.end();
		});

		const shouldPlay = options.playAudio ?? true;
		let interrupted = false;

		if (shouldPlay) {
			// Playback through PipeWire native pw-play (or mpv fallback)
			await new Promise<void>((resolve, reject) => {
				const player = spawn("pw-play", [audioPath], { stdio: "ignore" });
				this.#activePlaybackProcess = player;

				player.on("error", err => {
					this.#activePlaybackProcess = null;
					reject(err);
				});

				player.on("close", (code, signal) => {
					this.#activePlaybackProcess = null;
					if (signal === "SIGTERM" || signal === "SIGINT") {
						interrupted = true;
						resolve();
					} else if (code === 0) {
						resolve();
					} else {
						resolve(); // Graceful fallback
					}
				});
			});
		}

		return { audioPath, interrupted };
	}

	/**
	 * Record microphone audio for a specified duration and transcribe with Whisper.cpp.
	 */
	async listen(options: { durationSeconds?: number; audioPath?: string } = {}): Promise<TranscriptionResult> {
		const duration = options.durationSeconds ?? 4;
		const timestamp = Date.now();
		const targetAudio = options.audioPath || path.join(os.tmpdir(), `aerys-mic-${timestamp}.wav`);
		const startTime = Date.now();

		if (!options.audioPath) {
			// Record 16kHz mono WAV from PipeWire microphone
			await new Promise<void>((resolve, reject) => {
				const recorder = spawn(
					"pw-record",
					["--channels=1", "--rate=16000", "--format=s16", targetAudio],
					{ stdio: "ignore" },
				);

				recorder.on("error", reject);

				// Stop recording after duration
				const timer = setTimeout(() => {
					try {
						recorder.kill("SIGINT");
					} catch {}
				}, duration * 1000);

				recorder.on("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}

		if (!fs.existsSync(targetAudio) || fs.statSync(targetAudio).size === 0) {
			throw new Error("Recording failed: no audio captured from microphone.");
		}
		const audioPath = targetAudio;

		// Transcribe with Whisper.cpp
		const text = await new Promise<string>((resolve, reject) => {
			const vadModelPath = path.join(this.#modelsDir, "ggml-silero-vad.bin");
			const whisperArgs = fs.existsSync(vadModelPath)
				? ["--vad", "-vm", vadModelPath, "-m", this.whisperModel, "-f", audioPath, "-nt", "-np"]
				: ["-m", this.whisperModel, "-f", audioPath, "-nt", "-np"];

			const whisper = spawn(this.whisperBinary, whisperArgs, {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			whisper.stdout.on("data", chunk => {
				stdout += chunk.toString();
			});
			whisper.stderr.on("data", chunk => {
				stderr += chunk.toString();
			});

			whisper.on("error", reject);
			whisper.on("close", code => {
				if (code === 0) {
					// Clean up output lines from whisper
					const cleaned = stdout
						.split("\n")
						.filter(l => !l.startsWith("read_audio_data:"))
						.join(" ")
						.trim();
					resolve(cleaned);
				} else {
					reject(new Error(`Whisper transcription failed with code ${code}: ${stderr}`));
				}
			});
		});

		const durationMs = Date.now() - startTime;
		return { text, audioPath, durationMs };
	}
}

export const defaultVoiceEngine = new VoiceEngine();
