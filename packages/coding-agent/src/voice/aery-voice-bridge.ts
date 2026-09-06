/**
 * Aerys Direct Voice Bridge (isair/jarvis Architecture).
 *
 * Connects your live microphone directly to Aery:
 * 1. Listens silently for wake-words: "Aerys", "Aery", "Aries", "Airy"
 * 2. Completely ignores background conversation, TV, and fan noise.
 * 3. When called, routes the user's spoken command directly into Aery's prompt.
 * 4. Aery executes the turn with all tools and speaks her response through PipeWire.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeRms, pcmToWav } from "./voice-daemon";
import { transcribeWithGroq } from "./groq-whisper";
import { detectWakeWord } from "./wake-word";

const PIPER_BIN = path.join(os.homedir(), ".local", "share", "aerys", "voice", "bin", "piper");
const PIPER_MODEL = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "en_US-hfc_female-medium.onnx");

let isSpeaking = false;
let lastSpeechTime = 0;
const TAIL_ECHO_MS = 400;

async function acknowledgeAloud(text: string): Promise<void> {
	isSpeaking = true;
	const tmpWav = path.join(os.tmpdir(), `aerys-ack-${Date.now()}.wav`);
	try {
		await new Promise<void>((resolve, reject) => {
			const piper = spawn(
				PIPER_BIN,
				[
					"--model", PIPER_MODEL,
					"--noise_scale", "0.33",
					"--noise_w", "0.4",
					"--length_scale", "1.06",
					"--output_file", tmpWav,
				],
				{ stdio: ["pipe", "ignore", "ignore"] },
			);
			piper.on("close", code => code === 0 ? resolve() : reject());
			piper.stdin.write(text);
			piper.stdin.end();
		});

		await new Promise<void>((resolve) => {
			const player = spawn("pw-play", [tmpWav], { stdio: "ignore" });
			player.on("close", () => resolve());
		});
	} catch {
	} finally {
		try {
			if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
		} catch {}
		lastSpeechTime = Date.now();
		setTimeout(() => {
			isSpeaking = false;
		}, TAIL_ECHO_MS);
	}
}

/** Injects command into active Kitty terminal window */
async function injectPromptIntoAery(query: string): Promise<boolean> {
	const socket = process.env.KITTY_LISTEN_ON;
	const windowId = process.env.KITTY_WINDOW_ID || "1";

	if (!socket) {
		console.log(`[Aery Voice Bridge] No KITTY_LISTEN_ON found. Query: "${query}"`);
		return false;
	}

	return new Promise<boolean>((resolve) => {
		const kitty = spawn("kitty", ["@", "--to", socket, "send-text", `--match=id:${windowId}`, `${query}\r`]);
		kitty.on("close", code => resolve(code === 0));
		kitty.on("error", () => resolve(false));
	});
}

export async function runVoiceBridge(): Promise<void> {
	console.log("══════════════════════════════════════════════════════════════");
	console.log("       AERYS NATIVE VOICE BRIDGE (isair/jarvis Mode)           ");
	console.log("══════════════════════════════════════════════════════════════");
	console.log(" • Wake Words: 'Aerys', 'Aery', 'Aries', 'Airy'");
	console.log(" • Routing: Directly into active Aery terminal session");
	console.log(" • Status: Silent background monitoring active");
	console.log("──────────────────────────────────────────────────────────────");

	const rec = spawn("pw-record", ["--channels=1", "--rate=16000", "--format=s16", "-"], {
		stdio: ["ignore", "pipe", "ignore"],
	});

	let utteranceChunks: Buffer[] = [];
	let voiceActive = false;
	let lastUtteranceTime = 0;
	let endpointTimer: NodeJS.Timeout | null = null;
	const SILENCE_TIMEOUT_MS = 600;

	rec.stdout?.on("data", async (chunk: Buffer) => {
		// Drop input while Aery is actively speaking or room echo is settling
		if (isSpeaking || Date.now() - lastSpeechTime < TAIL_ECHO_MS) {
			utteranceChunks = [];
			return;
		}

		const rms = computeRms(chunk);

		// Voice detection threshold on echo-cancelled stream
		if (rms >= 1000) {
			lastUtteranceTime = Date.now();
			if (!voiceActive) {
				voiceActive = true;
				utteranceChunks = [chunk];

				if (endpointTimer) clearInterval(endpointTimer);
				endpointTimer = setInterval(async () => {
					if (!voiceActive) return;
					const elapsed = Date.now() - lastUtteranceTime;
					if (elapsed >= SILENCE_TIMEOUT_MS) {
						clearInterval(endpointTimer!);
						endpointTimer = null;
						voiceActive = false;

						const pcm = Buffer.concat(utteranceChunks);
						utteranceChunks = [];

						// Ignore clicks under 0.6s
						if (pcm.length < 10000) return;

						const wav = pcmToWav(pcm);
						const res = await transcribeWithGroq(wav);
						const raw = res?.text?.trim();

						if (!raw || raw.length < 2) return;

						// Check wake word (isair/jarvis protocol)
						const match = detectWakeWord(raw);
						if (!match.detected) {
							// Silently ignore background conversation
							return;
						}

						console.log(`\n[Wake Word Detected]: "${match.matchedWord}" | Query: "${match.query}"`);

						if (!match.query || match.query.length < 2) {
							// Peter just said "Aerys" -> acknowledge and listen
							await acknowledgeAloud("Yes, Peter?");
						} else {
							// Peter gave a command -> inject into Aery!
							await injectPromptIntoAery(match.query);
						}
					}
				}, 100);
			} else {
				utteranceChunks.push(chunk);
			}
		} else if (voiceActive) {
			utteranceChunks.push(chunk);
		}
	});

	rec.on("close", () => {
		console.log("Voice bridge closed.");
	});
}

if (import.meta.main) {
	await runVoiceBridge();
}
