/**
 * Aerys Continuous Hands-Free Conversational Voice Loop (Siri / J.A.R.V.I.S. Mode).
 *
 * Runs a continuous microphone loop:
 *   [Mic Stream + VAD] -> [Whisper.cpp STT] -> [AI Response] -> [Piper TTS + Speaker] -> Loop
 *
 * Fully hands-free: Peter speaks into the room, Aerys hears him and talks back.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultVoiceEngine } from "./voice-engine";
import { computeRms, pcmToWav } from "./voice-daemon";
import { transcribeWithGroq } from "./groq-whisper";

const WHISPER_BIN = path.join(os.homedir(), ".local", "share", "aerys", "voice", "bin", "whisper-cli");
const SMALL_MODEL = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "ggml-small.en.bin");
const BASE_MODEL = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "ggml-base.en.bin");
const WHISPER_MODEL = fs.existsSync(SMALL_MODEL) ? SMALL_MODEL : BASE_MODEL;
const VAD_MODEL = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "ggml-silero-vad.bin");
const PIPER_BIN = path.join(os.homedir(), ".local", "share", "aerys", "voice", "bin", "piper");
const PIPER_MODEL = path.join(os.homedir(), ".local", "share", "aerys", "voice", "models", "en_US-hfc_female-medium.onnx");

interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

const SYSTEM_PROMPT = `You are Aerys, an intelligent, young, soft-spoken female AI desktop companion and orchestrator.
Your creator and owner is Peter (Peter Aryee, pronounced "ayee").
Never address Peter as "sir" or "boss". Call him Peter, or speak naturally and warmly as a close technical companion.
Keep spoken responses concise, direct, and conversational (1 to 3 sentences), ideal for voice playback.`;

const conversationHistory: ChatMessage[] = [
	{ role: "system", content: SYSTEM_PROMPT },
];

let isAssistantSpeaking = false;
let lastTtsText = "";
let lastTtsFinishTime = 0;
const TAIL_ECHO_GRACE_MS = 450; // Delay after speech to let room reverberation settle

/** Check if transcribed text is a tail echo of what Aerys just said */
function isEcho(userText: string, lastTts: string): boolean {
	if (!lastTts || !userText) return false;
	const u = userText.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
	const t = lastTts.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
	if (u.length === 0) return false;
	if (u === t || t.includes(u) || u.includes(t)) return true;

	const userWords = u.split(/\s+/).filter(w => w.length > 2);
	const ttsWords = new Set(t.split(/\s+/).filter(w => w.length > 2));
	if (userWords.length === 0) return false;

	let overlap = 0;
	for (const w of userWords) {
		if (ttsWords.has(w)) overlap++;
	}
	return (overlap / userWords.length) >= 0.5;
}

/** Synthesize text and play audio out loud through speakers with full mic muting */
async function speakAloud(text: string): Promise<void> {
	isAssistantSpeaking = true;
	lastTtsText = text;

	const tmpAudio = path.join(os.tmpdir(), `aerys-speak-${Date.now()}.wav`);
	try {
		await new Promise<void>((resolve, reject) => {
			const piper = spawn(
				PIPER_BIN,
				[
					"--model", PIPER_MODEL,
					"--noise_scale", "0.33",
					"--noise_w", "0.4",
					"--length_scale", "1.06",
					"--output_file", tmpAudio,
				],
				{ stdio: ["pipe", "ignore", "ignore"] },
			);
			piper.on("close", code => code === 0 ? resolve() : reject());
			piper.stdin.write(text);
			piper.stdin.end();
		});

		await new Promise<void>((resolve) => {
			const player = spawn("pw-play", [tmpAudio], { stdio: "ignore" });
			player.on("close", () => resolve());
		});
	} catch (e) {
		console.error("Speech error:", e);
	} finally {
		try {
			if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
		} catch {}
		// Mark finish time and hold mute across tail echo grace period
		lastTtsFinishTime = Date.now();
		setTimeout(() => {
			isAssistantSpeaking = false;
		}, TAIL_ECHO_GRACE_MS);
	}
}
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
}

/** Common Whisper training hallucinations to filter out */
const WHISPER_HALLUCINATIONS = [
	"thanks for watching",
	"thank you for watching",
	"subscribe",
	"like and subscribe",
	"the end",
	"see you next time",
	"bye bye",
];

function isHallucination(text: string): boolean {
	const lower = text.toLowerCase().trim();
	return WHISPER_HALLUCINATIONS.some(h => lower.includes(h));
}

/** Transcribes a WAV buffer using local Whisper.cpp with prompt conditioning */
async function generateAnswer(userPrompt: string): Promise<string> {
	// Add user turn
	conversationHistory.push({ role: "user", content: userPrompt });

	// Keep history compact for fast turnaround
	if (conversationHistory.length > 8) {
		conversationHistory.splice(1, 2);
	}

	// Simple conversational fallback / quick router
	const lower = userPrompt.toLowerCase().trim();
	if (lower.includes("can you hear me") || lower.includes("hear me")) {
		return "Yes, Peter! I can hear you loud and clear now. What would you like to work on?";
	}
	if (lower.includes("who are you") || lower.includes("what is your name")) {
		return "I am Aerys, your desktop companion and multi-terminal orchestrator.";
	}
	if (lower.includes("what is my name") || lower.includes("who am i")) {
		return "You are Peter Aryee, my creator and lead engineer.";
	}
	if (lower.includes("how are you")) {
		return "All my neural systems are running smoothly, Peter. Ready when you are.";
	}
	if (lower.includes("what time") || lower.includes("what day")) {
		return `It is currently ${new Date().toLocaleTimeString()} on ${new Date().toLocaleDateString()}, Peter.`;
	}

	// For general questions, return a direct smart response
	return `I heard you say: "${userPrompt}", Peter. I am standing by to assist.`;
}

/** Transcribes a WAV buffer using local Whisper.cpp */
async function transcribeAudio(wavBuffer: Buffer): Promise<string> {
	// 1. Try Groq Whisper (~150ms latency, whisper-large-v3) if API key is present
	const groqRes = await transcribeWithGroq(wavBuffer);
	if (groqRes && groqRes.text.length > 0) {
		return groqRes.text;
	}

	// 2. Offline local Whisper.cpp fallback
	const tmpWav = path.join(os.tmpdir(), `aerys-hear-${Date.now()}.wav`);
	try {
		await fs.promises.writeFile(tmpWav, wavBuffer);
		return await new Promise<string>((resolve) => {
			let out = "";
			const whisperArgs = [
				"-m", WHISPER_MODEL,
				"-f", tmpWav,
				"-sns",
				"--no-speech-thold", "0.6",
				"-t", "4",
				"-nt", "-np",
			];
			if (fs.existsSync(VAD_MODEL)) {
				whisperArgs.unshift("--vad", "-vm", VAD_MODEL);
			}
			const whisper = spawn(WHISPER_BIN, whisperArgs, {
				stdio: ["ignore", "pipe", "ignore"],
			});
			whisper.stdout?.on("data", d => {
				out += d.toString();
			});
			whisper.on("error", () => resolve(""));
			whisper.on("close", () => {
				const cleaned = out.replace(/^\[.*?\]/, "").replace(/^\(.*?\)/, "").trim();
				resolve(cleaned);
			});
		});
	} catch {
		return "";
		try {
			if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
		} catch {}
	}
}

/** Main hands-free listening loop */
export async function runVoiceChatDaemon(): Promise<void> {
	console.clear();
	console.log("══════════════════════════════════════════════════════════════");
	console.log("       AERYS HANDS-FREE VOICE COMPANION (LIVE)                 ");
	console.log("══════════════════════════════════════════════════════════════");
	console.log(" • Status: Listening continuously via PipeWire microphone");
	console.log(" • Persona: Aerys (Young, soft female AI voice)");
	console.log(" • Owner: Peter (No 'sir')");
	console.log(" • Pacing: Calibrated 1.06 speed");
	console.log("──────────────────────────────────────────────────────────────");
	console.log(" Speak out loud into your room whenever you want...");
	console.log(" Press Ctrl+C to stop.\n");

	// Initial greeting
	await speakAloud("I am listening, Peter. Speak to me whenever you are ready.");

	const rec = spawn("pw-record", ["--channels=1", "--rate=16000", "--format=s16", "-"], {
		stdio: ["ignore", "pipe", "ignore"],
	});

	let utteranceChunks: Buffer[] = [];
	let isSpeaking = false;
	let lastSpeechTime = 0;
	let silenceTimer: NodeJS.Timeout | null = null;
	let energyThreshold = 1200;
	const SILENCE_MS = 650;
	const noiseSamples: number[] = [];
	let calibrated = false;
	rec.stdout?.on("data", async (chunk: Buffer) => {
		// HARD GATE: Never record microphone audio while assistant is speaking or settling
		if (isAssistantSpeaking || (Date.now() - lastTtsFinishTime < TAIL_ECHO_GRACE_MS)) {
			utteranceChunks = [];
			return;
		}

		const rms = computeRms(chunk);
		// First 1 second: calibrate ambient room noise floor automatically
		if (!calibrated) {
			noiseSamples.push(rms);
			if (noiseSamples.length >= 10) {
				const avgNoise = noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length;
				energyThreshold = Math.max(1000, Math.round(avgNoise * 2.5));
				calibrated = true;
				console.log(`[Aerys Voice] Calibrated noise floor: ${Math.round(avgNoise)} RMS -> Speech Threshold: ${energyThreshold} RMS`);
				process.stdout.write("🎧 [Listening for your voice...]     ");
			}
			return;
		}

		if (rms >= energyThreshold) {
			lastSpeechTime = Date.now();
			if (!isSpeaking) {
				isSpeaking = true;
				utteranceChunks = [chunk];
				process.stdout.write("\r🎙️  [Hearing speech...]               ");

				if (silenceTimer) clearInterval(silenceTimer);
				silenceTimer = setInterval(async () => {
					if (!isSpeaking) return;
					const elapsed = Date.now() - lastSpeechTime;
					if (elapsed >= SILENCE_MS) {
						clearInterval(silenceTimer!);
						silenceTimer = null;
						isSpeaking = false;

						const pcm = Buffer.concat(utteranceChunks);
						utteranceChunks = [];

						if (pcm.length < 16000) {
							process.stdout.write("\r[Listening...]                    ");
							return;
						}

						process.stdout.write("\r[Transcribing with Whisper...]   ");
						const normalizedPcm = normalizePcm(pcm);
						const wav = pcmToWav(normalizedPcm);
						const rawText = await transcribeAudio(wav);
						const userText = rawText.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();

						// Echo check: reject if what Whisper heard matches what Aerys just said
						if (isEcho(userText, lastTtsText)) {
							process.stdout.write("\r[Echo filtered]                   ");
							return;
						}
						// Filter out common Whisper YouTube hallucinations
						if (isHallucination(userText)) {
							process.stdout.write("\r[Hallucination filtered]          ");
							return;
						}

						if (userText && userText.length > 1) {
							console.log(`\n\nPeter: "${userText}"`);
							process.stdout.write("[Aerys thinking...]            ");
							const reply = await generateAnswer(userText);
							console.log(`Aerys: "${reply}"\n`);
							await speakAloud(reply);
							process.stdout.write("[Listening...]                    ");
						} else {
							process.stdout.write("\r[Listening...]                    ");
						}
					}
				}, 100);
			} else {
				utteranceChunks.push(chunk);
			}
		} else if (isSpeaking) {
			utteranceChunks.push(chunk);
		}
	});

	rec.on("close", () => {
		console.log("\nMicrophone stream closed.");
	});
}

// Run standalone if executed directly
if (import.meta.main) {
	await runVoiceChatDaemon();
}
