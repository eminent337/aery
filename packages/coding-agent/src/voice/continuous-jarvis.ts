/**
 * Aerys: Continuous J.A.R.V.I.S. Voice Assistant.
 *
 * Implements a bulletproof, continuous hands-free voice loop:
 * - Strictly requires wake-word ("Aerys" or "Hey Aerys") to avoid false triggers.
 * - Hardware/Software Half-Duplex: Mic is 100% muted while Aerys is thinking or speaking.
 * - 500ms room reverberation settling delay so she never hears her own voice.
 * - Sub-200ms Groq Whisper Large-v3 speech recognition.
 * - Real Aerys AgentSession equipped with all desktop tools (desktop_control, terminal_pane).
 * - Automatic desktop context injection (battery, active window, open apps).
 * - Speaks answers out loud with her calibrated soft AI voice (hfc_female at 1.06 speed).
 * - Voice shutdown: "Aerys, shut down" exits cleanly.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createAgentSession } from "../sdk";
import { defaultVoiceEngine } from "./voice-engine";
import { transcribeWithGroq } from "./groq-whisper";
import { detectWakeWord } from "./wake-word";
import { computeRms, pcmToWav } from "./voice-daemon";

const execFileAsync = promisify(execFile);

const WAKE_CHIME = path.join(os.homedir(), ".local", "share", "aerys", "voice", "wake-chime.wav");
const TAIL_ECHO_GRACE_MS = 500;
const SPEECH_THRESHOLD_RMS = 600; // Sensitive enough for casual room speech, well above ~200 RMS room floor
const SILENCE_TIMEOUT_MS = 1000; // 1.0s natural pause before finalizing speech

let isSpeaking = false;
let isBusy = false;
let lastSpeechFinishedAt = 0;

/** Play the subtle J.A.R.V.I.S. wake chime */
function playWakeChime(): Promise<void> {
	if (!fs.existsSync(WAKE_CHIME)) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const player = spawn("pw-play", [WAKE_CHIME], { stdio: "ignore" });
		player.on("close", () => resolve());
		player.on("error", () => resolve());
	});
}

/** Speak out loud with Aerys's calibrated soft AI voice with mic mute */
async function speak(text: string): Promise<void> {
	if (!text || !text.trim()) return;
	isSpeaking = true;
	try {
		console.log(`🤖 Aerys: "${text.trim()}"\n`);
		await defaultVoiceEngine.speak(text.trim());
	} catch (e) {
		console.error("[Speech Error]:", e);
	} finally {
		lastSpeechFinishedAt = Date.now();
		setTimeout(() => {
			isSpeaking = false;
		}, TAIL_ECHO_GRACE_MS);
	}
}

/** Audio peak normalization */
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

/** Filter out standalone Whisper silence hallucinations */
const GHOST_HALLUCINATIONS: Record<string, true> = {
	"thank you": true,
	"thank you.": true,
	thanks: true,
	"thanks.": true,
	"thank you very much": true,
	"thank you for watching": true,
	"thank you for watching.": true,
	"thanks for watching": true,
	"thanks for watching.": true,
	"thanks for watching!": true,
	you: true,
	bye: true,
	"bye.": true,
	cheers: true,
	f: true,
	salo: true,
	yeah: true,
	"yeah.": true,
	yes: true,
	yep: true,
};

function isGhostHallucination(text: string): boolean {
	const cleaned = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
	return Boolean(GHOST_HALLUCINATIONS[cleaned]);
}

/** Real-time desktop telemetry snapshot */
async function getDesktopSnapshot(): Promise<{
	time: string;
	date: string;
	battery: string;
	activeWindow: string;
	openApps: string[];
}> {
	const now = new Date();
	const time = now.toLocaleTimeString();
	const date = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

	let battery = "Unknown";
	try {
		const cap = (await fs.promises.readFile("/sys/class/power_supply/BAT0/capacity", "utf-8")).trim();
		const stat = (await fs.promises.readFile("/sys/class/power_supply/BAT0/status", "utf-8")).trim();
		battery = `${cap}% and ${stat.toLowerCase()}`;
	} catch {}

	let activeWindow = "Desktop";
	let openApps: string[] = [];

	try {
		const { stdout } = await execFileAsync("hyprctl", ["activewindow", "-j"]);
		const win = JSON.parse(stdout);
		if (win?.title) activeWindow = `"${win.title}" (${win.class})`;
	} catch {}

	try {
		const { stdout } = await execFileAsync("hyprctl", ["clients", "-j"]);
		const clients = JSON.parse(stdout) as Array<{ class: string; title: string; workspace: { id: number } }>;
		openApps = clients.map(c => `[ws:${c.workspace?.id || 1}] ${c.class} ("${c.title}")`);
	} catch {}

	return { time, date, battery, activeWindow, openApps };
}

/** Check if query requests visual screen inspection */
function isVisionQuery(text: string): boolean {
	const lower = text.toLowerCase();
	const keywords = [
		"look at my screen",
		"what's on my screen",
		"what is on my screen",
		"what am i looking at",
		"what do you see",
		"check my screen",
		"read my screen",
		"take a screenshot",
	];
	return keywords.some(k => lower.includes(k));
}

/** Extract concise spoken text from assistant message */
function extractSpokenText(markdown: string): string {
	let clean = markdown.replace(/```[\s\S]*?```/g, "").trim();
	clean = clean.replace(/^#+\s+.*$/gm, "").trim();
	clean = clean.replace(/[*_`~]/g, "");
	clean = clean.replace(/\[(.*?)\]\(.*?\)/g, "$1");
	clean = clean.replace(/<.*?>/g, "");

	const paragraphs = clean
		.split(/\n\s*\n/)
		.map(p => p.trim())
		.filter(p => p.length > 5 && !p.startsWith("-") && !p.startsWith("*") && !p.startsWith("|"));

	if (paragraphs.length === 0) return "";
	const firstP = paragraphs[0].replace(/\n+/g, " ");
	const sentences = firstP.match(/[^.!?]+[.!?]+/g) || [firstP];
	return sentences.slice(0, 2).join(" ").trim();
}

/** Main continuous J.A.R.V.I.S. loop */
export async function runContinuousJarvis(): Promise<void> {
	console.clear();
	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║                 AERYS: J.A.R.V.I.S. MODE                     ║");
	console.log("╠══════════════════════════════════════════════════════════════╣");
	console.log("║  • Interface: Continuous Voice Assistant (Hands-Free)        ║");
	console.log("║  • Wake Word: 'Aerys' or 'Aery' (Strict leading trigger)     ║");
	console.log("║  • Owner: Peter (Peter Aryee)                                ║");
	console.log("║  • Speech: Groq Whisper (150ms) + Neural Voice (Piper)       ║");
	console.log("║  • Tools Active: Desktop Vision, Kitty Panes, Bash, Files    ║");
	console.log("║  • Voice Shutdown: Say 'Aerys, shut down'                    ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");
	console.log("\n[Initializing Aerys Agent Session with all desktop tools...]");

	const { session } = await createAgentSession({ cwd: process.cwd() });
	console.log("✔ Aerys Agent ready. Desktop tools active (vision, terminal panes, bash, files).");

	// Initial spoken announcement
	await speak("I am online, Peter. I am listening across your machine.");

	const rec = spawn("pw-record", ["--channels=1", "--rate=16000", "--format=s16", "-"], {
		stdio: ["ignore", "pipe", "ignore"],
	});

	let utteranceChunks: Buffer[] = [];
	let voiceActive = false;
	let lastUtteranceTime = 0;
	let endpointTimer: NodeJS.Timeout | null = null;

	rec.stdout?.on("data", async (chunk: Buffer) => {
		// HARD GATE: Never record while Aerys is thinking, running tools, or speaking
		if (isBusy || isSpeaking || Date.now() - lastSpeechFinishedAt < TAIL_ECHO_GRACE_MS) {
			utteranceChunks = [];
			return;
		}

		const rms = computeRms(chunk);

		if (rms >= SPEECH_THRESHOLD_RMS) {
			lastUtteranceTime = Date.now();
			if (!voiceActive) {
				voiceActive = true;
				utteranceChunks = [chunk];
				process.stdout.write("\r🎙️  [Hearing speech...]                   ");

				if (endpointTimer) clearInterval(endpointTimer);
				endpointTimer = setInterval(async () => {
					if (!voiceActive) return;
					const elapsed = Date.now() - lastUtteranceTime;
					if (elapsed >= SILENCE_TIMEOUT_MS) {
						clearInterval(endpointTimer!);
						endpointTimer = null;
						voiceActive = false;
						process.stdout.write("\r🎧 [Listening for 'Aerys'...]          ");

						const pcm = Buffer.concat(utteranceChunks);
						utteranceChunks = [];

						// Ignore short clicks (< 0.6s)
						if (pcm.length < 10000) return;

						const normalizedPcm = normalizePcm(pcm);
						const wav = pcmToWav(normalizedPcm);
						const res = await transcribeWithGroq(wav);
						const raw = res?.text?.trim();

						if (!raw || raw.length < 2) return;
						if (isGhostHallucination(raw)) return;

						// Strict wake-word check (isair/jarvis + slappy_AI_ pattern)
						const match = detectWakeWord(raw);
						if (!match.detected) {
							// Not addressed to Aerys -> silently ignore!
							return;
						}

						await playWakeChime();

						if (!match.query || match.query.length < 2) {
							// Peter called "Aerys" with no command -> acknowledge
							console.log(`\n🗣️  Peter: "${raw}"`);
							await speak("Yes, Peter?");
							return;
						}

						const q = match.query.toLowerCase().trim();

						// Voice shutdown check
						if (
							q === "shut down" ||
							q === "shutdown" ||
							q === "exit" ||
							q === "quit" ||
							q === "go to sleep" ||
							q === "stop listening" ||
							q === "goodbye" ||
							q === "bye"
						) {
							console.log(`\n🗣️  Peter: "${match.query}"`);
							await speak("Shutting down, Peter. Goodbye.");
							try {
								rec.kill("SIGINT");
							} catch {}
							process.exit(0);
						}

						// Execute command through real Aerys AgentSession
						if (isBusy) return;
						isBusy = true;
						console.log(`\n🗣️  Peter: "${match.query}"`);
						console.log("⚡ [Executing command with desktop tools...]");

						try {
							// Automatic live desktop context injection
							const snap = await getDesktopSnapshot();
							let fullPrompt = match.query;
							fullPrompt +=
								`\n\n[LIVE DESKTOP CONTEXT]\n` +
								`- Time: ${snap.time} on ${snap.date}\n` +
								`- Battery: ${snap.battery}\n` +
								`- Active Window: ${snap.activeWindow}\n` +
								`- Open Apps: ${snap.openApps.slice(0, 6).join(", ")}\n[END CONTEXT]`;

							if (isVisionQuery(match.query)) {
								console.log("👁️ [Capturing screen vision snapshot with grim...]");
								const shotPath = path.join(os.tmpdir(), "aerys-vision.png");
								await execFileAsync("grim", [shotPath]);
								fullPrompt += `\n[SCREEN VISION ATTACHED: Live screenshot captured at ${shotPath}. Inspect the screen image and report what you see.]`;
							}

							await session.prompt(fullPrompt);

							const last = session.getLastAssistantMessage?.();
							if (last) {
								const text = last.content
									.filter(c => c.type === "text")
									.map(c => c.text)
									.join("\n");
								const summary = extractSpokenText(text);
								if (summary) {
									await speak(summary);
								}
							}
						} catch (err: unknown) {
							const error = err as Error;
							console.error("[Execution error]:", error.message);
							await speak("I encountered an issue running that command, Peter.");
						} finally {
							lastSpeechFinishedAt = Date.now();
							isBusy = false;
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
		console.log("\nAerys voice stream closed.");
	});
}

if (import.meta.main) {
	await runContinuousJarvis();
}
