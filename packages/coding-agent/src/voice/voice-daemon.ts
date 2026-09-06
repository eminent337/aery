/**
 * Aerys Ambient Voice Daemon.
 *
 * Implements real-time Voice Activity Detection (VAD), dynamic endpointing,
 * and barge-in interruption handling directly over PipeWire streams.
 *
 * Architecture inspired by livekit-agents endpointing.py & speech_handle.py.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultVoiceEngine } from "./voice-engine";

export interface VoiceDaemonOptions {
	energyThreshold?: number; // RMS threshold for speech detection
	silenceDurationMs?: number; // Silence duration before endpointing (default: 700ms)
	maxUtteranceSec?: number; // Max length of a single spoken utterance (default: 15s)
	onSpeechDetected?: (text: string) => Promise<void> | void;
}

export interface VoiceDaemonStatus {
	running: boolean;
	listening: boolean;
	recordingUtterance: boolean;
	pid?: number;
}

/** Converts raw 16kHz 16-bit mono PCM into a standard RIFF WAV buffer */
export function pcmToWav(pcmData: Buffer, sampleRate = 16000, numChannels = 1): Buffer {
	const header = Buffer.alloc(44);
	const dataSize = pcmData.length;
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // PCM subchunk size
	header.writeUInt16LE(1, 20); // Linear PCM
	header.writeUInt16LE(numChannels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * numChannels * 2, 28);
	header.writeUInt16LE(numChannels * 2, 32);
	header.writeUInt16LE(16, 34); // Bits per sample
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);
	return Buffer.concat([header, pcmData]);
}

/** Computes RMS audio energy of a 16-bit signed PCM buffer */
export function computeRms(buffer: Buffer): number {
	let sum = 0;
	const sampleCount = Math.floor(buffer.length / 2);
	if (sampleCount === 0) return 0;
	for (let i = 0; i < sampleCount; i++) {
		const sample = buffer.readInt16LE(i * 2);
		sum += sample * sample;
	}
	return Math.sqrt(sum / sampleCount);
}

export class VoiceDaemon {
	#recProcess: ChildProcess | null = null;
	#running = false;
	#recordingUtterance = false;
	#utteranceBuffers: Buffer[] = [];
	#lastSpeechTime = 0;
	#silenceCheckTimer: NodeJS.Timeout | null = null;
	#maxDurationTimer: NodeJS.Timeout | null = null;

	readonly #energyThreshold: number;
	readonly #silenceDurationMs: number;
	readonly #maxUtteranceSec: number;
	#onSpeechDetected?: (text: string) => Promise<void> | void;

	constructor(options: VoiceDaemonOptions = {}) {
		this.#energyThreshold = options.energyThreshold ?? 7000;
		this.#silenceDurationMs = options.silenceDurationMs ?? 750;
		this.#maxUtteranceSec = options.maxUtteranceSec ?? 15;
		this.#onSpeechDetected = options.onSpeechDetected;
	}

	setOnSpeechDetected(callback: (text: string) => Promise<void> | void): void {
		this.#onSpeechDetected = callback;
	}

	getStatus(): VoiceDaemonStatus {
		return {
			running: this.#running,
			listening: this.#running && !this.#recordingUtterance,
			recordingUtterance: this.#recordingUtterance,
			pid: this.#recProcess?.pid,
		};
	}

	/** Start the background ambient listening loop */
	start(): boolean {
		if (this.#running) return false;

		// Spawn streaming PipeWire recorder
		const rec = spawn("pw-record", ["--channels=1", "--rate=16000", "--format=s16", "-"], {
			stdio: ["ignore", "pipe", "ignore"],
		});

		this.#recProcess = rec;
		this.#running = true;

		rec.stdout?.on("data", (chunk: Buffer) => {
			this.#handleAudioChunk(chunk);
		});

		rec.on("error", () => {
			this.stop();
		});

		rec.on("close", () => {
			this.#running = false;
			this.#recProcess = null;
		});

		return true;
	}

	/** Stop the background ambient listening loop */
	stop(): boolean {
		if (!this.#running) return false;

		this.#running = false;
		if (this.#silenceCheckTimer) clearInterval(this.#silenceCheckTimer);
		if (this.#maxDurationTimer) clearTimeout(this.#maxDurationTimer);

		if (this.#recProcess) {
			try {
				this.#recProcess.kill("SIGTERM");
			} catch {}
			this.#recProcess = null;
		}

		this.#recordingUtterance = false;
		this.#utteranceBuffers = [];
		return true;
	}

	#handleAudioChunk(chunk: Buffer): void {
		const rms = computeRms(chunk);

		if (rms >= this.#energyThreshold) {
			this.#lastSpeechTime = Date.now();

			// If Aerys is currently speaking out loud, interrupt immediately (Barge-in)!
			defaultVoiceEngine.stopSpeaking();

			if (!this.#recordingUtterance) {
				// Transition to active speech collection
				this.#recordingUtterance = true;
				this.#utteranceBuffers = [chunk];
				this.#startUtteranceTimers();
			} else {
				this.#utteranceBuffers.push(chunk);
			}
		} else if (this.#recordingUtterance) {
			// In speech collection, buffer until silence timeout
			this.#utteranceBuffers.push(chunk);
		}
	}

	#startUtteranceTimers(): void {
		if (this.#silenceCheckTimer) clearInterval(this.#silenceCheckTimer);
		if (this.#maxDurationTimer) clearTimeout(this.#maxDurationTimer);

		// Periodic check for silence endpointing (> 750ms of silence)
		this.#silenceCheckTimer = setInterval(() => {
			if (!this.#recordingUtterance) return;
			const silenceElapsed = Date.now() - this.#lastSpeechTime;
			if (silenceElapsed >= this.#silenceDurationMs) {
				this.#finalizeUtterance();
			}
		}, 100);

		// Safety ceiling for maximum utterance length
		this.#maxDurationTimer = setTimeout(() => {
			if (this.#recordingUtterance) {
				this.#finalizeUtterance();
			}
		}, this.#maxUtteranceSec * 1000);
	}

	async #finalizeUtterance(): Promise<void> {
		if (this.#silenceCheckTimer) clearInterval(this.#silenceCheckTimer);
		if (this.#maxDurationTimer) clearTimeout(this.#maxDurationTimer);
		this.#silenceCheckTimer = null;
		this.#maxDurationTimer = null;

		if (!this.#recordingUtterance) return;
		this.#recordingUtterance = false;

		const pcm = Buffer.concat(this.#utteranceBuffers);
		this.#utteranceBuffers = [];

		// Filter out sub-second clicks/pops (< 0.5s of audio)
		if (pcm.length < 16000) return;

		const wav = pcmToWav(pcm);
		const tmpWav = path.join(os.tmpdir(), `aerys-utterance-${Date.now()}.wav`);
		try {
			await fs.promises.writeFile(tmpWav, wav);

			// Transcribe with Whisper.cpp
			const text = await new Promise<string>((resolve, reject) => {
				const vadModelPath = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "ggml-silero-vad.bin");
				const whisperArgs = fs.existsSync(vadModelPath)
					? ["--vad", "-vm", vadModelPath, "-m", defaultVoiceEngine.whisperModel, "-f", tmpWav, "-nt", "-np"]
					: ["-m", defaultVoiceEngine.whisperModel, "-f", tmpWav, "-nt", "-np"];

				const whisper = spawn(defaultVoiceEngine.whisperBinary, whisperArgs, {
					stdio: ["ignore", "pipe", "ignore"],
				});

				let stdout = "";
				whisper.stdout?.on("data", d => {
					stdout += d.toString();
				});
				whisper.on("error", reject);
				whisper.on("close", code => {
					if (code === 0) {
						resolve(stdout.trim());
					} else {
						resolve("");
					}
				});
			});

			const cleaned = text.replace(/^\[.*?\]/, "").replace(/^\(.*?\)/, "").trim();
			if (cleaned.length > 0 && this.#onSpeechDetected) {
				await this.#onSpeechDetected(cleaned);
			}
		} catch {
		} finally {
			try {
				if (fs.existsSync(tmpWav)) await fs.promises.unlink(tmpWav);
			} catch {}
		}
	}
}

export const defaultVoiceDaemon = new VoiceDaemon();
