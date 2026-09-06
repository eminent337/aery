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
import { defaultVoiceEngine } from "../voice/voice-engine";

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

	// 1. Fast path: Groq LPU Whisper (~150ms latency, whisper-large-v3)
	if (process.env.GROQ_API_KEY) {
		try {
			const groqRes = await transcribeWithGroq(buf);
			if (groqRes && groqRes.text && groqRes.text.length > 0) {
				logger.debug("Groq Whisper transcription complete", {
					text: groqRes.text,
					latencyMs: groqRes.latencyMs,
				});
				return groqRes.text;
			}
		} catch (e) {
			logger.debug("Groq Whisper unavailable, falling back to local engine", { error: e });
		}
	}

	// 2. Offline fallback: local static whisper-cli
	if (defaultVoiceEngine.isReady()) {
		const res = await defaultVoiceEngine.listen({ audioPath });
		return res.text;
	}

	throw new Error("No speech-to-text engine available. Set GROQ_API_KEY or install local voice models.");
}
