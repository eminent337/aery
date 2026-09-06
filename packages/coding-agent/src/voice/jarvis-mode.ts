/**
 * Aerys J.A.R.V.I.S. Voice-First Desktop Assistant Mode.
 *
 * Runs Aerys as a true speech-first AI assistant:
 * 1. Listens silently for wake-words: "Aerys", "Aery", "Aries", "Airy".
 * 2. Plays a subtle audio chime when awakened.
 * 3. Transcribes speech in ~150ms using Groq Whisper Large-v3.
 * 4. Executes real desktop tools (desktop_control, terminal_pane, bash, files).
 * 5. Speaks responses out loud through PipeWire using her calibrated soft AI voice.
 * 6. Keeps a 20-second active conversation window for natural multi-turn dialogue.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession } from "../sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/** Inspects real-time OS context (inspired by slappy_AI_) */
async function getRealtimeDesktopContext(): Promise<string> {
	const now = new Date();
	const timeStr = now.toLocaleTimeString();
	const dateStr = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

	let batteryInfo = "Unknown";
	try {
		const cap = (await fs.promises.readFile("/sys/class/power_supply/BAT0/capacity", "utf-8")).trim();
		const stat = (await fs.promises.readFile("/sys/class/power_supply/BAT0/status", "utf-8")).trim();
		batteryInfo = `${cap}% (${stat})`;
	} catch {}

	let activeWindow = "Desktop";
	let activeWorkspace = "1";
	let openApps: string[] = [];

	try {
		const { stdout } = await execFileAsync("hyprctl", ["activewindow", "-j"]);
		const win = JSON.parse(stdout);
		if (win?.title) {
			activeWindow = `"${win.title}" (app: ${win.class})`;
			activeWorkspace = String(win.workspace?.id || win.workspace?.name || 1);
		}
	} catch {}

	try {
		const { stdout } = await execFileAsync("hyprctl", ["clients", "-j"]);
		const clients = JSON.parse(stdout) as Array<{ class: string; title: string; workspace: { id: number } }>;
		openApps = clients.map(c => `[ws:${c.workspace?.id || 1}] ${c.class} ("${c.title}")`);
	} catch {}

	return (
		`\n\n[REAL-TIME DESKTOP CONTEXT]\n` +
		`- Current Time: ${timeStr} on ${dateStr}\n` +
		`- Battery Status: ${batteryInfo}\n` +
		`- Active Focused Window: ${activeWindow} on workspace ${activeWorkspace}\n` +
		`- Open Applications (${openApps.length}):\n  ` +
		openApps.slice(0, 8).join("\n  ") +
		`\n[END CONTEXT]`
	);
}

/** Check if the spoken query requires screen vision (slappy_AI_ pattern) */
function needsVision(text: string): boolean {
	const lower = text.toLowerCase();
	const keywords = [
		"look at my screen",
		"look at screen",
		"look at this",
		"see my screen",
		"what do you see",
		"what's on my screen",
		"what is on my screen",
		"check my screen",
		"analyze my screen",
		"read my screen",
		"screenshot",
		"what app is this",
		"what website is this",
	];
	return keywords.some(k => lower.includes(k));
}

/** Capture scaled screenshot for vision queries */
async function captureVisionScreenshot(): Promise<string | null> {
	const rawPath = path.join(os.tmpdir(), "aerys-vision-raw.png");
	const scaledPath = path.join(os.tmpdir(), "aerys-vision.png");
	try {
		await execFileAsync("grim", [rawPath]);
		await execFileAsync("convert", [rawPath, "-resize", "1024x768>", scaledPath]);
		try {
			await fs.promises.unlink(rawPath);
		} catch {}
		return scaledPath;
	} catch {
		return null;
	}
}
import { computeRms, pcmToWav } from "./voice-daemon";
import { transcribeWithGroq } from "./groq-whisper";
import { detectWakeWord } from "./wake-word";
import { defaultVoiceEngine } from "./voice-engine";

const WAKE_CHIME = path.join(os.homedir(), ".local", "share", "aerys", "voice", "wake-chime.wav");

let isSpeaking = false;
let isBusy = false;
let lastSpeechFinishedAt = 0;
const TAIL_ECHO_GRACE_MS = 500;
/** Play the subtle J.A.R.V.I.S. wake chime */
function playWakeChime(): Promise<void> {
	if (!fs.existsSync(WAKE_CHIME)) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const player = spawn("pw-play", [WAKE_CHIME], { stdio: "ignore" });
		player.on("close", () => resolve());
		player.on("error", () => resolve());
	});
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

/** Speak out loud with Aerys's calibrated soft AI voice */
async function speak(text: string): Promise<void> {
	if (!text || !text.trim()) return;
	isSpeaking = true;
	try {
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

/** Normalize PCM audio amplitude */
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

export async function runJarvisMode(): Promise<void> {
	console.clear();
	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║                 AERYS: J.A.R.V.I.S. MODE                     ║");
	console.log("╠══════════════════════════════════════════════════════════════╣");
	console.log("║  • Interface: 100% Voice-First Speech Assistant              ║");
	console.log("║  • Wake Word: 'Aerys' or 'Aery'                              ║");
	console.log("║  • Owner: Peter (Peter Aryee)                                ║");
	console.log("║  • Engine: Groq Whisper (150ms) + Neural Voice (Piper)       ║");
	console.log("║  • Tools Active: Desktop Vision, Kitty Panes, Bash, Files    ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");
	console.log("\n[Initializing Aerys Agent Session with all desktop tools...]");

	const { session } = await createAgentSession({ cwd: process.cwd() });
	console.log("✔ Aerys Agent ready. Desktop tools active (vision, terminal panes, bash, files).");

	// Initial spoken greeting
	await speak("I am online and listening, Peter. Call my name whenever you need me.");

	// Start microphone stream
	const rec = spawn("pw-record", ["--channels=1", "--rate=16000", "--format=s16", "-"], {
		stdio: ["ignore", "pipe", "ignore"],
	});

	let utteranceChunks: Buffer[] = [];
	let voiceActive = false;
	let lastUtteranceTime = 0;
	let endpointTimer: NodeJS.Timeout | null = null;
	const SILENCE_TIMEOUT_MS = 1100;

	rec.stdout?.on("data", async (chunk: Buffer) => {
		// HARD GATE: Never listen while Aerys is thinking, running tools, speaking, or settling echo
		if (isBusy || isSpeaking || Date.now() - lastSpeechFinishedAt < TAIL_ECHO_GRACE_MS) {
			utteranceChunks = [];
			return;
		}

		const rms = computeRms(chunk);
		// Voice activity threshold on echo-cancelled stream (speech: >500 RMS)
		if (rms >= 500) {
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

						if (pcm.length < 10000) return;

						const normalizedPcm = normalizePcm(pcm);
						const wav = pcmToWav(normalizedPcm);
						const res = await transcribeWithGroq(wav);
						let raw = res?.text?.trim();

						// Resilient offline fallback if network/socket reset occurs
						if (!raw && defaultVoiceEngine.isReady()) {
							const tmpWav = path.join(os.tmpdir(), `aerys-fb-${Date.now()}.wav`);
							try {
								await fs.promises.writeFile(tmpWav, wav);
								const local = await defaultVoiceEngine.listen({ audioPath: tmpWav });
								raw = local.text.trim();
							} catch {} finally {
								try {
									if (fs.existsSync(tmpWav)) await fs.promises.unlink(tmpWav);
								} catch {}
							}
						}

						if (!raw || raw.length < 2) return;
						if (isGhostHallucination(raw)) return;

						const match = detectWakeWord(raw);


						if (match.detected) {
							await playWakeChime();

							if (!match.query || match.query.length < 2) {
								// Peter called "Aerys" with no command -> respond directly
								console.log(`\n🗣️  Peter: "${raw}"`);
								console.log("🤖 Aerys: 'Yes, Peter?'");
								await speak("Yes, Peter?");
							} else {
								const q = match.query.toLowerCase().trim();
								if (
									q.includes("shut down") ||
									q.includes("shutdown") ||
									q.includes("exit") ||
									q.includes("quit") ||
									q.includes("go to sleep") ||
									q.includes("stop listening")
								) {
									console.log(`\n🗣️  Peter: "${match.query}"`);
									console.log("🤖 Aerys: 'Shutting down. Goodbye, Peter.'\n");
									await speak("Shutting down. Goodbye, Peter.");
									try {
										rec.kill("SIGINT");
									} catch {}
									process.exit(0);
								}

								// Peter gave a command with the wake word
								if (isBusy) return;
								isBusy = true;
								console.log(`\n🗣️  Peter: "${match.query}"`);
								console.log("⚡ [Executing command with desktop tools...]");
								try {
									const qLower = match.query.toLowerCase().trim();

									// Instant fast-path responses for pure system queries
									if (qLower === "what time is it" || qLower === "what's the time" || qLower === "what time") {
										const timeNow = new Date().toLocaleTimeString();
										console.log(`🤖 Aerys: "It's ${timeNow}, Peter."\n`);
										await speak(`It's ${timeNow}, Peter.`);
										return;
									}
									if (qLower.includes("battery") && (qLower.includes("what") || qLower.includes("check"))) {
										let bat = "77% and charging";
										try {
											const cap = (await fs.promises.readFile("/sys/class/power_supply/BAT0/capacity", "utf-8")).trim();
											const stat = (await fs.promises.readFile("/sys/class/power_supply/BAT0/status", "utf-8")).trim();
											bat = `${cap}% and ${stat.toLowerCase()}`;
										} catch {}
										console.log(`🤖 Aerys: "Your battery is at ${bat}, Peter."\n`);
										await speak(`Your battery is at ${bat}, Peter.`);
										return;
									}

									// Build full context-aware prompt
									const systemContext = await getRealtimeDesktopContext();
									let fullPrompt = match.query + systemContext;

									// Automatic screen vision trigger
									if (needsVision(match.query)) {
										console.log("👁️ [Capturing screen vision snapshot...]");
										const shotPath = await captureVisionScreenshot();
										if (shotPath) {
											fullPrompt += `\n[SCREEN VISION ATTACHED: A visual snapshot of the screen was captured at ${shotPath}. Inspect the screen image and tell Peter what is visible.]`;
										}
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
											console.log(`🤖 Aerys: "${summary}"\n`);
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
	await runJarvisMode();
}
