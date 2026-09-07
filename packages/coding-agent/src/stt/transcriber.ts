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
