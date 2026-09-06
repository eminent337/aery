/**
 * Aerys Voice Biometrics Enrollment CLI.
 *
 * Records a 4-second calibration sample of Peter's voice and creates his
 * permanent neural speaker embedding profile.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultVoiceEngine } from "./voice-engine";
import { enrollPeter } from "./speaker-id";

async function speak(text: string): Promise<void> {
	try {
		await defaultVoiceEngine.speak(text);
	} catch (e) {
		console.error("Speech output error:", e);
	}
}

async function playChime(): Promise<void> {
	const chime = path.join(os.homedir(), ".local", "share", "aerys", "voice", "wake-chime.wav");
	if (!fs.existsSync(chime)) return;
	await new Promise<void>((resolve) => {
		const player = spawn("pw-play", [chime], { stdio: "ignore" });
		player.on("close", () => resolve());
		player.on("error", () => resolve());
	});
}

export async function runEnrollment(): Promise<void> {
	console.clear();
	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║             AERYS VOICE BIOMETRIC ENROLLMENT                 ║");
	console.log("╠══════════════════════════════════════════════════════════════╣");
	console.log("║  • Target: Peter (Peter Aryee)                               ║");
	console.log("║  • Neural Engine: CAM++ (sherpa-onnx)                        ║");
	console.log("║  • Purpose: Calibrate your vocal fingerprint so Aerys only   ║");
	console.log("║             responds to you and ignores her own voice/echo   ║");
	console.log("╚══════════════════════════════════════════════════════════════╝\n");

	console.log("Preparing microphone calibration...\n");
	await speak("Peter, please speak a sentence after the chime to calibrate your personal voiceprint.");

	await Bun.sleep(500);
	await playChime();

	console.log("🎙️  [RECORDING YOUR VOICE NOW - SPEAK A SENTENCE (4 seconds)...]");
	console.log("Example: 'I am Peter Aryee, and Aerys is my personal companion.'\n");

	try {
		const result = await enrollPeter();
		console.log("\n✔ Voice calibration complete!");
		console.log("Profile saved to:", result.profilePath);
		console.log("Registered in: speaker.txt\n");

		await speak("Voiceprint calibrated successfully, Peter. I will now recognize your voice.");
		console.log("Aerys is now locked to Peter's voice.");
	} catch (err: unknown) {
		const error = err as Error;
		console.error("Enrollment failed:", error.message);
		await speak("Voice calibration failed, Peter. Please try again.");
	}
}

if (import.meta.main) {
	await runEnrollment();
}
