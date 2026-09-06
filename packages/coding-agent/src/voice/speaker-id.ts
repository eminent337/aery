/**
 * Aerys Speaker Verification & Voice Biometrics Engine.
 *
 * Uses CAM++ neural speaker embeddings (sherpa-onnx) to verify WHO is speaking.
 * Matches incoming voice against Peter's enrolled voiceprint.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BASE_VOICE_DIR = path.join(os.homedir(), ".local", "share", "aerys", "voice");
const PROFILES_DIR = path.join(BASE_VOICE_DIR, "profiles");
const SPEAKER_TXT = path.join(BASE_VOICE_DIR, "speaker.txt");
const SPEAKER_MODEL = path.join(BASE_VOICE_DIR, "models", "campplus_speaker.onnx");
const IDENTIFIER_BIN = path.join(BASE_VOICE_DIR, "bin", "sherpa-onnx-microphone-offline-speaker-identification");

export function isSpeakerModelAvailable(): boolean {
	return fs.existsSync(SPEAKER_MODEL) && fs.existsSync(IDENTIFIER_BIN);
}

export function isPeterEnrolled(): boolean {
	const p = path.join(PROFILES_DIR, "peter_profile.wav");
	return fs.existsSync(p) && fs.existsSync(SPEAKER_TXT);
}

/**
 * Enrolls Peter's voice by recording an 8-second calibration sample.
 */
export async function enrollPeter(durationSec = 8, audioSamplePath?: string): Promise<{ success: boolean; profilePath: string }> {
	await fs.promises.mkdir(PROFILES_DIR, { recursive: true });
	const targetPath = path.join(PROFILES_DIR, "peter_profile.wav");

	if (audioSamplePath && fs.existsSync(audioSamplePath)) {
		await fs.promises.copyFile(audioSamplePath, targetPath);
	} else {
		// Record 4 seconds of Peter speaking via PipeWire
		await new Promise<void>((resolve, reject) => {
			const rec = spawn(
				"pw-record",
				["--channels=1", "--rate=16000", "--format=s16", targetPath],
				{ stdio: "ignore" },
			);
			rec.on("error", reject);
			setTimeout(() => {
				try {
					rec.kill("SIGINT");
				} catch {}
			}, durationSec * 1000);
			rec.on("close", () => resolve());
		});
	}

	if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size < 1000) {
		throw new Error("Voice enrollment failed: audio sample too short or empty.");
	}

	// Write speaker.txt file
	const content = `Peter ${targetPath}\n`;
	await fs.promises.writeFile(SPEAKER_TXT, content, "utf-8");

	return { success: true, profilePath: targetPath };
}
