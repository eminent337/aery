import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@aryee337/aery-utils";

/**
 * Find a usable Python command.
 */
export function resolvePython(): string | null {
	for (const cmd of ["python", "py", "python3"]) {
		if ($which(cmd)) return cmd;
	}
	return null;
}
import { transcribeWithGroq } from "../voice/groq-whisper";

export interface TranscribeOptions {
	modelName?: string;
	language?: string;
	signal?: AbortSignal;
}

/**
 * Transcribe a WAV file using Groq Whisper (150ms) or local whisper-cli fallback.
 * Completely eliminates Python and pip dependencies.
 */
export async function transcribe(audioPath: string, options?: TranscribeOptions): Promise<string> {
	const audioFile = Bun.file(audioPath);
	if (audioFile.size < 100) {
		throw new Error(`Audio file is empty or too small (${audioFile.size} bytes). Check microphone.`);
	}

	const buf = Buffer.from(await audioFile.arrayBuffer());

	// Energy gate: Groq whisper-large-v3 hallucinates fluent phrases ("Thank you.",
	// "I'm going to go ahead and do that.") from digital silence at temperature 0,
	// and its no_speech_prob filter does not catch these. Confirmed experimentally:
	// a 9.8s capture of ~RMS 14-20 (digital noise floor) transcribed as "Thank you."
	// Rejected here before any network round-trip by measuring true AC RMS (DC mean
	// subtracted per chunk) on 16-bit mono PCM. 350 is well above the observed
	// digital floor (~20) and echo-cancel ambient (~20-30), and far below real
	// speech (thousands).
	const speechRms = measureSpeechRms(buf);
	if (speechRms < 350) {
		logger.debug("Silence gate: rejecting near-silent audio before STT", { speechRms });
		return "";
	}

	// 1. Fast path: Groq LPU Whisper (~150ms latency, checks env & agent.db)
	try {
		const groqRes = await transcribeWithGroq(buf);
		if (groqRes && groqRes.text && groqRes.text.length > 0) {
			logger.debug("Groq Whisper transcription complete", {
				text: groqRes.text,
				latencyMs: groqRes.latencyMs,
			});
			return groqRes.text;
		}
	} catch {
		// Network failure: return empty so the caller reports "No speech detected"
		// rather than crashing the speech loop.
		return "";
	}

	// Local whisper-cli fallback is disabled by design: it eats 130% CPU on this machine,
	// spins the fans up to 5100 RPM, and the fan roar then drowns out the microphone.
	// Groq LPU is the sole STT engine.
	return "";
}

/**
 * True AC RMS of a WAV buffer (16-bit PCM), matching the recorder's DC-subtraction
 * approach: split into ~100ms chunks, subtract each chunk's mean (removes DC offset
 * and low-frequency drift), then average per-chunk RMS across chunks. Chunk-local
 * means keep drifting mic bias (ALC3235) from faking energy.
 */
export function measureSpeechRms(wav: Buffer): number {
	// Locate PCM data via RIFF chunk walk (streaming headers may carry size 0).
	let off = 12;
	let dataStart = -1;
	let dataLen = 0;
	while (off + 8 <= wav.length) {
		const id = wav.toString("ascii", off, off + 4);
		const size = wav.readUInt32LE(off + 4);
		if (id === "data") {
			dataStart = off + 8;
			dataLen = size && size !== 0xffffffff ? size : wav.length - dataStart;
			break;
		}
		off += 8 + size + (size % 2);
	}
	if (dataStart < 0 || dataLen < 2) return 0;

	const sampleCount = Math.floor(dataLen / 2);
	const chunkSamples = 1600; // ~100ms @16kHz; exact rate is irrelevant for RMS
	let sumSquares = 0;
	let chunkCount = 0;
	for (let start = 0; start < sampleCount; start += chunkSamples) {
		const end = Math.min(start + chunkSamples, sampleCount);
		let mean = 0;
		for (let i = start; i < end; i++) mean += wav.readInt16LE(dataStart + i * 2);
		mean /= end - start;
		let rmsAcc = 0;
		for (let i = start; i < end; i++) {
			const v = wav.readInt16LE(dataStart + i * 2) - mean;
			rmsAcc += v * v;
		}
		sumSquares += rmsAcc / (end - start);
		chunkCount++;
	}
	return Math.sqrt(sumSquares / chunkCount);
}
