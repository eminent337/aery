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

/** Audio peak normalization: scales quiet speech to standard optimal range for Whisper */
function normalizePcm(pcm: Buffer): Buffer {
	let maxVal = 0;
	const sampleCount = Math.floor(pcm.length / 2);
	if (sampleCount === 0) return pcm;

	for (let i = 0; i < sampleCount; i++) {
		const val = Math.abs(pcm.readInt16LE(i * 2));
		if (val > maxVal) maxVal = val;
	}

	if (maxVal < 400 || maxVal >= 28000) return pcm;

	const gain = 26000 / maxVal;
	const out = Buffer.alloc(pcm.length);
	for (let i = 0; i < sampleCount; i++) {
		const sample = pcm.readInt16LE(i * 2);
		const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
		out.writeInt16LE(boosted, i * 2);
	}
	return out;
const GHOST_HALLUCINATIONS = new Set([
	"thank you",
	"thank you very much",
	"thanks",
	"you",
	"bye",
	"cheers",
	"f",
	"salo",
]);

function isGhostHallucination(text: string): boolean {
	const cleaned = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
	return GHOST_HALLUCINATIONS.has(cleaned);
}


const PIPER_BIN = path.join(os.homedir(), ".local", "share", "aerys", "voice", "bin", "piper");
const PIPER_MODEL = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "en_US-hfc_female-medium.onnx");

let isSpeaking = false;
let lastSpeechTime = 0;
const TAIL_ECHO_MS = 400;
let hotWindowExpiry = Date.now() + 60_000; // Start with a 60s open window for immediate conversation
const HOT_WINDOW_DURATION_MS = 25_000; // 25s conversational follow-up window after each interaction

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

/** Generates an intelligent companion response via Groq and speaks it out loud */
async function generateAndSpeak(userPrompt: string): Promise<void> {
	const key = process.env.GROQ_API_KEY;
	let reply = "I'm right here with you, Peter.";
	if (key) {
		try {
			const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "qwen/qwen3.8-27b",
					messages: [
						{
							role: "system",
							content:
								'You are Aerys, an intelligent, young, soft-spoken female AI desktop companion. Your creator and owner is Peter (Peter Aryee). Never address Peter as "sir" or "boss" — always call him Peter. Speak naturally, warmly, and concisely (1 to 2 spoken sentences) like a real human partner and companion. Answer directly without robotic filler.',
						},
						{ role: "user", content: userPrompt },
					],
					max_tokens: 80,
					temperature: 0.7,
				}),
			});
			if (res.ok) {
				const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
				reply = data.choices?.[0]?.message?.content?.trim() || reply;
			}
		} catch {}
	}
	console.log(`[Aerys Spoke]: "${reply}"`);
	await acknowledgeAloud(reply);
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
	const SILENCE_TIMEOUT_MS = 1100; // 1.1s natural speech pause so sentences aren't split

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

						const normalizedPcm = normalizePcm(pcm);
						const wav = pcmToWav(normalizedPcm);
						const res = await transcribeWithGroq(wav);
						const raw = res?.text?.trim();

						if (!raw || raw.length < 2) return;

						// Filter out standalone Whisper silence hallucinations (stops the "you're welcome" loop)
						if (isGhostHallucination(raw)) {
							return;
						}
						const match = detectWakeWord(raw);
						const inHotWindow = Date.now() < hotWindowExpiry;

						console.log(`[Heard (${res?.latencyMs ?? 0}ms)]: "${raw}" | wake: ${match.detected} | active: ${inHotWindow}`);

						if (match.detected) {
							hotWindowExpiry = Date.now() + HOT_WINDOW_DURATION_MS;
							if (!match.query || match.query.length < 2) {
								await acknowledgeAloud("Yes, Peter?");
							} else {
								await generateAndSpeak(match.query);
							}
						} else if (inHotWindow) {
							// Active conversation mode: answer follow-up directly through speakers
							hotWindowExpiry = Date.now() + HOT_WINDOW_DURATION_MS;
							await generateAndSpeak(raw);
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
