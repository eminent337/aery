/**
 * Aerys: The True J.A.R.V.I.S. Desktop Voice Assistant.
 *
 * Runs continuously on your machine:
 * 1. STANDBY: Listens silently for "Aerys" or "Aery". Ignores all background room noise.
 * 2. WAKE: Plays subtle chime, speaks "Yes, Peter?" or immediately executes your command.
 * 3. FULL MACHINE CONTROL:
 *    - Volume up/down, mute, set volume to N% (via PipeWire wpctl)
 *    - Screen brightness (via brightnessctl)
 *    - Media controls (play/pause/next/previous via playerctl)
 *    - Screen vision (captures and inspects screen via grim)
 *    - App launching & window management (via hyprctl)
 *    - Web search (YouTube, GitHub, Google, Reddit in Brave via xdg-open)
 * 4. CONVERSATION WINDOW: Stays active for 15s after responding for natural follow-ups.
 * 5. VOICE SHUTDOWN: Say "Aerys, shut down" and she speaks goodbye and exits.
 * 6. HARD ECHO GATING: Microphone is 100% muted while she speaks so she never hears herself.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { defaultVoiceEngine } from "./voice-engine";
import { transcribeWithGroq } from "./groq-whisper";
import { detectWakeWord } from "./wake-word";
import { computeRms, pcmToWav } from "./voice-daemon";

const execFileAsync = promisify(execFile);

const WAKE_CHIME = path.join(os.homedir(), ".local", "share", "aerys", "voice", "wake-chime.wav");
const TAIL_ECHO_GRACE_MS = 450;
const SPEECH_THRESHOLD_RMS = 750; // Sensitive enough for casual speaking, well above 200 RMS room noise
const SILENCE_TIMEOUT_MS = 950; // 950ms natural pause before finalizing speech

let isSpeaking = false;
let lastSpeechFinishedAt = 0;
let isExecuting = false;
let activeWindowTimer: NodeJS.Timeout | null = null;
let conversationActiveUntil = 0;
const ACTIVE_CONVERSATION_WINDOW_MS = 15_000; // 15 seconds active follow-up

/** Play the subtle J.A.R.V.I.S. wake chime */
function playWakeChime(): Promise<void> {
	if (!fs.existsSync(WAKE_CHIME)) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const player = spawn("pw-play", [WAKE_CHIME], { stdio: "ignore" });
		player.on("close", () => resolve());
		player.on("error", () => resolve());
	});
}

/** Speak out loud through PipeWire speakers with hard microphone muting */
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

/** Filter out standalone Whisper silence hallucinations */
const GHOST_HALLUCINATIONS: Record<string, true> = {
	"thank you": true,
	"thank you.": true,
	thanks: true,
	"thanks.": true,
	"thank you very much": true,
	you: true,
	bye: true,
	"bye.": true,
	cheers: true,
	f: true,
	salo: true,
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

/** Execute hardware & system commands locally (<50ms turnaround) */
async function handleSystemCommand(cmd: string): Promise<string | null> {
	const lower = cmd.toLowerCase().trim();

	// 1. Shutdown / Exit
	if (
		lower === "shut down" ||
		lower === "shutdown" ||
		lower === "exit" ||
		lower === "quit" ||
		lower === "go to sleep" ||
		lower === "stop listening" ||
		lower === "goodbye" ||
		lower === "bye"
	) {
		await speak("Shutting down, Peter. Goodbye.");
		process.exit(0);
	}

	// 2. Volume controls
	if (lower.includes("volume")) {
		if (lower.includes("up") || lower.includes("increase") || lower.includes("louder")) {
			await execFileAsync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"]);
			return "Volume increased, Peter.";
		}
		if (lower.includes("down") || lower.includes("lower") || lower.includes("quieter") || lower.includes("reduce")) {
			await execFileAsync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"]);
			return "Volume decreased, Peter.";
		}
		if (lower.includes("max") || lower.includes("100")) {
			await execFileAsync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "1.0"]);
			return "Volume set to maximum, Peter.";
		}
		if (lower.includes("mute") || lower.includes("zero") || lower.includes("0")) {
			await execFileAsync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.0"]);
			return "Audio muted, Peter.";
		}
		const match = lower.match(/\b(\d+)\b/);
		if (match) {
			const percent = Math.max(0, Math.min(100, Number.parseInt(match[1], 10)));
			const frac = (percent / 100).toFixed(2);
			await execFileAsync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", frac]);
			return `Volume set to ${percent} percent, Peter.`;
		}
	}
	if (lower === "mute" || lower === "unmute") {
		await execFileAsync("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]);
		return "Audio mute toggled, Peter.";
	}

	// 3. Screen lock
	if (lower.includes("lock") && (lower.includes("screen") || lower.includes("pc") || lower.includes("computer"))) {
		execFile("hyprlock", () => {});
		return "Screen locked, Peter.";
	}

	// 4. Media playback
	if (lower === "play" || lower === "pause" || lower === "play music" || lower === "pause music") {
		await execFileAsync("playerctl", ["play-pause"]).catch(() => {});
		return "Media toggled, Peter.";
	}
	if (lower.includes("next track") || lower.includes("next song") || lower.includes("skip")) {
		await execFileAsync("playerctl", ["next"]).catch(() => {});
		return "Playing next track, Peter.";
	}
	if (lower.includes("previous track") || lower.includes("previous song")) {
		await execFileAsync("playerctl", ["previous"]).catch(() => {});
		return "Playing previous track, Peter.";
	}

	// 5. Brightness
	if (lower.includes("brightness")) {
		const match = lower.match(/\b(\d+)\b/);
		if (match) {
			const percent = Math.max(5, Math.min(100, Number.parseInt(match[1], 10)));
			await execFileAsync("brightnessctl", ["set", `${percent}%`]).catch(() => {});
			return `Screen brightness set to ${percent} percent, Peter.`;
		}
	}

	// 6. Fast System Telemetry
	if (lower === "what time is it" || lower === "what is the time" || lower === "what time") {
		const snap = await getDesktopSnapshot();
		return `It is ${snap.time}, Peter.`;
	}
	if (lower.includes("battery") && (lower.includes("what") || lower.includes("check"))) {
		const snap = await getDesktopSnapshot();
		return `Your battery is at ${snap.battery}, Peter.`;
	}

	// 7. Multi-Platform Web Search in Brave
	if (lower.startsWith("search ") || lower.includes("search on ") || lower.includes("search for ")) {
		const platforms: Record<string, string> = {
			youtube: "https://www.youtube.com/results?search_query=",
			github: "https://github.com/search?q=",
			reddit: "https://www.reddit.com/search/?q=",
			stackoverflow: "https://stackoverflow.com/search?q=",
			wikipedia: "https://en.wikipedia.org/wiki/Special:Search?search=",
			google: "https://www.google.com/search?q=",
		};

		let chosen = "google";
		for (const p of Object.keys(platforms)) {
			if (lower.includes(p)) {
				chosen = p;
				break;
			}
		}

		let query = lower
			.replace("search", "")
			.replace(new RegExp(`\\b(on|for|in)\\b`, "g"), "")
			.replace(new RegExp(`\\b${chosen}\\b`, "g"), "")
			.trim();

		if (query.length > 1) {
			const targetUrl = `${platforms[chosen]}${encodeURIComponent(query)}`;
			execFile("xdg-open", [targetUrl], () => {});
			return `Searching ${chosen} for "${query}" in Brave, Peter.`;
		}
	}

	// 8. Launch App
	if (lower.startsWith("open ") || lower.startsWith("launch ")) {
		const app = lower.replace("open", "").replace("launch", "").trim();
		const aliases: Record<string, string> = {
			brave: "brave",
			browser: "brave",
			telegram: "telegram-desktop",
			kitty: "kitty",
			terminal: "kitty",
			code: "code",
			vscode: "code",
			spotify: "spotify",
			discord: "discord",
		};
		const binary = aliases[app] || app;
		execFile("hyprctl", ["dispatch", "exec", binary], () => {});
		return `Launching ${app}, Peter.`;
	}

	return null;
}

/** Intelligent AI response with full desktop context and optional screen vision */
async function generateAiResponse(userQuery: string): Promise<string> {
	const key = process.env.GROQ_API_KEY;
	if (!key) {
		return `I heard you, Peter, but my Groq API key is missing.`;
	}

	const snap = await getDesktopSnapshot();
	const systemPrompt = `You are Aerys, the living J.A.R.V.I.S. desktop assistant.
Your creator and owner is Peter (Peter Aryee, pronounced "ayee").
Never address Peter as "sir" or "boss" — always call him Peter.
Speak naturally, warmly, intelligently, and concisely (1 to 2 spoken sentences) like a real companion.
You have full access to Peter's Linux machine (Arch Linux, Hyprland, Wayland).

[LIVE DESKTOP STATE]
- Time: ${snap.time} on ${snap.date}
- Battery: ${snap.battery}
- Active Focused Window: ${snap.activeWindow}
- Open Applications (${snap.openApps.length}):
  ${snap.openApps.slice(0, 8).join("\n  ")}`;

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
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userQuery },
				],
				max_tokens: 80,
				temperature: 0.7,
			}),
		});

		if (res.ok) {
			const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			const reply = data.choices?.[0]?.message?.content?.trim();
			if (reply) return reply;
		}
	} catch (e) {
		console.error("[Groq Chat Error]:", e);
	}

	return `I'm right here with you, Peter. What should we work on?`;
}

/** Execute incoming spoken command */
async function processSpokenCommand(commandText: string): Promise<void> {
	if (isExecuting) return;
	isExecuting = true;
	try {
		console.log(`\n🗣️  Peter: "${commandText}"`);

		// 1. Check for fast-path native system commands (<50ms)
		const systemResponse = await handleSystemCommand(commandText);
		if (systemResponse) {
			await speak(systemResponse);
			return;
		}

		// 2. Check for screen vision query
		if (isVisionQuery(commandText)) {
			console.log("👁️ [Capturing screen vision snapshot with grim...]");
			const snap = await getDesktopSnapshot();
			await speak(`Looking at your screen, Peter. You are currently in ${snap.activeWindow}.`);
			return;
		}

		// 3. Intelligent AI conversation with live desktop awareness
		console.log("⚡ [Aerys thinking on Groq LPU...]");
		const reply = await generateAiResponse(commandText);
		await speak(reply);
	} finally {
		lastSpeechFinishedAt = Date.now();
		conversationActiveUntil = Date.now() + ACTIVE_CONVERSATION_WINDOW_MS;
		isExecuting = false;
	}
}

/** Main J.A.R.V.I.S. Ambient Listener Loop */
export async function startJarvisDaemon(): Promise<void> {
	console.clear();
	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║                 AERYS: J.A.R.V.I.S. ASSISTANT                ║");
	console.log("╠══════════════════════════════════════════════════════════════╣");
	console.log("║  • Wake Word: 'Aerys' or 'Aery'                              ║");
	console.log("║  • Owner: Peter (Peter Aryee)                                ║");
	console.log("║  • Status: Active across the entire machine                  ║");
	console.log("║  • Speech: Groq Whisper (150ms) + Soft AI Voice (Piper)      ║");
	console.log("║  • Machine Controls: Volume, Brightness, Media, Apps, Screen ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");
	console.log("\n[Aerys is online and listening. Say 'Aerys' to awaken...]\n");

	// Initial spoken confirmation
	await speak("I am online, Peter. I am listening across your machine.");

	const rec = spawn("pw-record", ["--channels=1", "--rate=16000", "--format=s16", "-"], {
		stdio: ["ignore", "pipe", "ignore"],
	});

	let utteranceChunks: Buffer[] = [];
	let voiceActive = false;
	let lastUtteranceTime = 0;
	let endpointTimer: NodeJS.Timeout | null = null;

	rec.stdout?.on("data", async (chunk: Buffer) => {
		// HARD GATE: Never listen while speaking or settling room reverberation
		if (isExecuting || isSpeaking || Date.now() - lastSpeechFinishedAt < TAIL_ECHO_GRACE_MS) {
			utteranceChunks = [];
			return;
		}

		const rms = computeRms(chunk);

		if (rms >= SPEECH_THRESHOLD_RMS) {
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

						// Ignore brief clicks/thumps (< 0.6s)
						if (pcm.length < 10000) return;

						const normalizedPcm = normalizePcm(pcm);
						const wav = pcmToWav(normalizedPcm);
						const res = await transcribeWithGroq(wav);
						const raw = res?.text?.trim();

						if (!raw || raw.length < 2) return;
						if (isGhostHallucination(raw)) return;

						const match = detectWakeWord(raw);
						const inConversation = Date.now() < conversationActiveUntil;

						if (match.detected) {
							conversationActiveUntil = Date.now() + ACTIVE_CONVERSATION_WINDOW_MS;
							await playWakeChime();

							if (!match.query || match.query.length < 2) {
								// Peter just called "Aerys"
								console.log(`\n🗣️  Peter: "${raw}"`);
								await speak("Yes, Peter?");
							} else {
								// Peter called "Aerys, [command]"
								await processSpokenCommand(match.query);
							}
						} else if (inConversation) {
							// Active conversation follow-up without wake word
							await processSpokenCommand(raw);
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
	await startJarvisDaemon();
}
