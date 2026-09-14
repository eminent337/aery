/**
 * Camera Control Tool.
 *
 * Lets the agent capture a frame from the webcam and run face detection
 * (YuNet via OpenCV in an isolated uv venv). Returns the JPEG as an image
 * content block (so vision models see it) plus a text summary with detected
 * face boxes.
 *
 * Offline + local: ffmpeg captures /dev/video*, the venv at
 * ~/.local/share/aerys/camera/venv runs cv2. No new deps in the TS repo.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";
import { captureScreenFrame } from "../voice/screen-vision";
import { ocrFrame } from "./screen-ocr";

const execFileAsync = promisify(execFile);

// Follows the established voice-assets pattern (speaker-id.ts / voice-engine.ts):
// runtime assets live outside the (byte-identical) TS repo.
const CAMERA_DIR = path.join(os.homedir(), ".local", "share", "aerys", "camera");
const DEFAULT_VENV_PYTHON = path.join(CAMERA_DIR, "venv", "bin", "python");
const DEFAULT_WORKER = path.join(CAMERA_DIR, "bin", "face_detect.py");
export interface DetectedFace {
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
	identity?: IdentityMatch | null;
}

const cameraControlSchema = z.object({
	action: z
		.enum([
			"capture",
			"list_devices",
			"enroll_face",
			"identify",
			"list_profiles",
			"record",
			"record_screen",
			"watch_start",
			"watch_stop",
			"watch_status",
			"watch_transcript",
			"watch_clear",
		])
		.describe(
			"Actions: 'capture' (frame + face detection), 'identify' (detect + WHO is in frame via enrolled face profiles), 'enroll_face' (register the person currently in frame under 'name'), 'list_profiles' (enrolled people), 'record' (webcam video mp4), 'record_screen' (screen video mp4, Hyprland/wf-recorder), 'watch_start'/'watch_stop'/'watch_status' (live-watch loop: screen OCR reads on change at a throttled cadence + camera face snapshots while you work — watch_status returns the latest on-screen text), 'watch_transcript' (append mode: return the accumulated OCR transcript for summarize/narrate — pair watch_start with append:true), 'watch_clear' (wipe the transcript), 'list_devices'.",
		),
	name: z
		.string()
		.optional()
		.describe("Identity name for 'enroll_face' (e.g. the user's name)."),
	append: z
		.boolean()
		.optional()
		.describe("watch_start with append:true accumulates every distinct OCR reading into a session transcript (a ~'book' the model can summarize/narrate via 'watch_transcript'); append deltas stream into context within the 50k budget. Default false (latest-only, context-bounded)."),
	duration: z
		.number()
		.optional()
		.describe("Seconds to record for 'record'/'record_screen' (default 5, max 60)."),
	lanes: z
		.enum(["both", "screen", "camera"])
		.optional()
		.describe("watch_start lane selection: 'both' (default) runs the screen lane (OCR) AND the camera lane (face snapshots); 'screen' = screen OCR only, no camera; 'camera' = camera face snapshots only, no screen OCR."),
	face_detection: z
		.boolean()
		.optional()
		.describe("Run YuNet face detection on the captured frame (default: true)."),
	device: z
		.string()
		.optional()
		.describe("Webcam device path (default: /dev/video0)."),
	resolution: z
		.string()
		.optional()
		.describe("Capture resolution as WIDTHxHEIGHT (default: 1280x720; lower like 640x480 is faster)."),
	include_image: z
		.boolean()
		.optional()
		.describe("Whether to return the JPEG image content block (default: true)."),
	ocr: z
		.boolean()
		.optional()
		.describe(
			"Extract in-frame text with tesseract OCR and return it as text (default: false). Use this when you cannot see images — the capture then reads the frame's text content. Adds ~0.3-2s.",
		),
	ocrLang: z
		.string()
		.optional()
		.describe("Tesseract language for 'ocr' (default: 'eng'; requires the language pack in /usr/share/tessdata)."),
});

export type CameraControlParams = z.infer<typeof cameraControlSchema>;

interface IdentityMatch {
	name: string;
	similarity: number;
}

interface EnrollResult {
	ok: boolean;
	profile?: string;
	facesInFrame?: number;
	error?: string;
}

interface WorkerResult {
	capture?: { device: string; size: [number, number]; jpeg: string; latencyMs: number };
	faces: DetectedFace[];
	detectionTimeMs: number;
	enroll?: EnrollResult;
	error?: string;
}

function findDeviceCandidates(): string[] {
	const candidates: string[] = [];
	for (let i = 0; i < 8; i++) {
		candidates.push(`/dev/video${i}`);
	}
	return candidates;
}

/**
 * Live-watch loop — ports the ambient screen-buffer pattern (screen-vision.ts)
 * to a dual-lane watcher: screen frames at ~1fps + camera face snapshots every
 * WATCH_CAMERA_INTERVAL_MS. CPU-bounded via a reentrancy guard per lane and a
 * bounded ring; the model queries status to answer "what am I doing?"-style
 * questions mid-task.
 */
interface WatchFrame {
	kind: "screen" | "camera";
	at: number;
	faces?: number;
	note?: string;
	/** OCR text of the screen frame (only set when the lane actually read it). */
	ocr?: string;
	/** Cheap pixel digest used to skip re-OCR when the screen hasn't meaningfully changed. */
	digest?: string;
}

const WATCH_SCREEN_INTERVAL_MS = 1000;
const WATCH_CAMERA_INTERVAL_MS = 5000;
const WATCH_MAX_FRAMES = 60;
/** Never OCR faster than this even if the screen churns (tesseract cost + context budget). */
const WATCH_OCR_MIN_INTERVAL_MS = 4000;
/** Hidden-steer delivery is capped: after this many substantive deltas we stop
 *  spamming the model; status still reflects the latest OCR text. */
const WATCH_STEER_MAX_PER_MINUTE = 6;
/** Append-mode transcript cap (chars). Oldest entries trimmed first — keeps a
 *  2h movie or a long book inside a readable budget (~50k chars ≈ 12k tokens). */
const WATCH_TRANSCRIPT_MAX_CHARS = 50_000;
/** Per-reading hidden-steer cap (chars): a single OCR delta is clipped before
 *  it is hidden-steered, so one giant frame can't blow the context budget.
 *  8000 matches the eye/screenshot/verify truncation — every OCR path now
 *  delivers the same full text, and the transcript (not the steer) is the
 *  durable copy. */
const WATCH_APPEND_STEER_MAX_CHARS = 8000;
/** How different (0..1) two wire-frame digests must be before we bother re-OCR. */
const WATCH_OCR_DIFF_THRESHOLD = 0.12;

/** Cheap content digest: sample a sparse grid of pixel bytes from the JPEG.
 *  Deterministic (stable across runs) + O(1) — good enough to gate OCR. */
export function watchDigestOf(jpeg: Buffer): string {
	const step = Math.max(16, Math.floor(jpeg.length / 512));
	let h = 2166136261;
	for (let i = 0; i < jpeg.length; i += step) {
		h ^= jpeg[i];
		h = (h * 16777619) & 0xffffffff;
	}
	return (h >>> 0).toString(16);
}

export function watchDiffFloor(a: string | undefined, b: string | undefined): number {
	if (!a || !b) return 1;
	// Cheap hamming-ish proxy: count differing nibbles (hex digests).
	let d = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) d += a[i] !== b[i] ? 1 : 0;
	const norm = d / Math.max(n, 1);
	return Math.min(1, norm * 8); // amplify so small pixel shifts read as real change
}

/** Decision function backing #maybeOcr — exported so the gate is unit-testable
 *  without a display or tesseract. True when (a) enough time has passed since the
 *  last OCR (throttle) AND (b) the screen digest moved past WATCH_OCR_DIFF_THRESHOLD. */
export function watchShouldOcr(lastOcrAt: number, now: number, lastDigest: string | undefined, digest: string): boolean {
	if (now - lastOcrAt < WATCH_OCR_MIN_INTERVAL_MS) return false;
	return watchDiffFloor(lastDigest, digest) >= WATCH_OCR_DIFF_THRESHOLD;
}
/** Normalize one OCR line for overlap detection (collapse whitespace). */
function normalizeWatchLine(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

/** Newly-visible lines in `next` relative to `previous` (exact normalized-line
 *  match). The append mode streams only these deltas as hidden steers — scrolling
 *  a book re-reads most of the same page, so the delta is the new content. */
export function watchLineDelta(previous: string | undefined, next: string): string {
	const seen = new Set(
		(previous ?? "")
			.split(/\r?\n/)
			.map(normalizeWatchLine)
			.filter(line => line.length >= 3),
	);
	return next
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length >= 3)
		.filter(line => {
			const norm = normalizeWatchLine(line);
			return !seen.has(norm);
		})
		.join("\n");
}

export class CameraWatchLoop {
	static #timer: ReturnType<typeof setInterval> | undefined;
	static #screenBusy = false;
	static #cameraBusy = false;
	static #frames: WatchFrame[] = [];
	static #startedAt: number | undefined;
	static #lastOcrAt = 0;
	static #lastDigest: string | undefined;
	static #ocrSwept = 0;
	static #steerCount = 0;
	/** Bumped on every start; in-flight async captures from a previous session
	 *  carry the old generation and are dropped instead of polluting the new
	 *  watch's frame ring. */
	static #generation = 0;
	static #steerWindowStart = Date.now();
	/** Append mode: accumulate every distinct reading into the transcript (a
	 *  "book") instead of keeping latest-only. Set via watch_start {append:true}. */
	static #appendMode = false;
	/** Lane selection: which feeds the watch loop actually runs.
	 *  "both" (default) = screen + camera; "screen" / "camera" run one lane. */
	static #lanes: "both" | "screen" | "camera" = "both";
	/** Append-mode transcript: every distinct OCR reading, timestamped, in order.
	 *  This is the "book" — the model reads it via watch_transcript to summarize
	 *  or narrate. Eye, screenshot and verify OCR readings are recorded here too
	 *  (via recordExternalOcr) so full text survives long after the ephemeral
	 *  image sweeps. Bounded by WATCH_TRANSCRIPT_MAX_CHARS (oldest entries trimmed). */
	static #transcript: Array<{ at: number; text: string; source?: string }> = [];
	/** Most recent OCR reading — basis for "newly visible" line deltas. */
	static #lastReadText: string | undefined;
	/** Chars of append steers already delivered to the model (context budget). */
	static #appendStreamChars = 0;
	/** True once the append stream hit the 50k context budget. */
	static #appendStreamOverflow = false;
	/** Append deltas skipped after the stream budget was exhausted. */
	static #appendStreamDropped = 0;
	/** Documented via the camera_control schema; the loop owns its own
	 *  steering capability (hook-free, sandboxed, cap-bounded). */
	static #session?: ToolSession;

	/** Configure the hidden-steer sink used for substantive OCR deltas. */
	static attachSession(session: ToolSession | undefined): void {
		CameraWatchLoop.#session = session;
	}
	static start(append = false, lanes: "both" | "screen" | "camera" = "both"): void {
		if (CameraWatchLoop.#timer !== undefined) return; // idempotent
		CameraWatchLoop.#generation++;
		CameraWatchLoop.#lanes = lanes;
		CameraWatchLoop.#frames = [];
		CameraWatchLoop.#tickNumber = 0;
		CameraWatchLoop.#startedAt = Date.now();
		CameraWatchLoop.#steerWindowStart = Date.now();
		CameraWatchLoop.#steerCount = 0;
		CameraWatchLoop.#lastOcrAt = 0;
		CameraWatchLoop.#lastDigest = undefined;
		CameraWatchLoop.#appendMode = append;
		CameraWatchLoop.#lastReadText = undefined;
		CameraWatchLoop.#appendStreamChars = 0;
		CameraWatchLoop.#appendStreamOverflow = false;
		CameraWatchLoop.#appendStreamDropped = 0;
		if (append && CameraWatchLoop.#transcript.length > 0) {
			CameraWatchLoop.#transcript.push({ at: Date.now(), text: `— watch session started ${new Date().toLocaleTimeString()} —` });
		}
		CameraWatchLoop.#timer = setInterval(() => {
			void CameraWatchLoop.#tick();
		}, WATCH_SCREEN_INTERVAL_MS);
	}

	static get running(): boolean {
		return CameraWatchLoop.#timer !== undefined;
	}

	static stop(): void {
		if (CameraWatchLoop.#timer !== undefined) {
			clearInterval(CameraWatchLoop.#timer);
			CameraWatchLoop.#timer = undefined;
			CameraWatchLoop.#startedAt = undefined;
			CameraWatchLoop.#lanes = "both";
		}
	}
	static #tickNumber = 0;
	/** Cheap content digest via the exported gate helpers. */
	static #digestOf(jpeg: Buffer): string {
		return watchDigestOf(jpeg);
	}

	static #diffFloor(a: string | undefined, b: string | undefined): number {
		return watchDiffFloor(a, b);
	}

	static async #maybeOcr(keepPath: string, digest: string): Promise<string | undefined> {
		const now = Date.now();
		if (!watchShouldOcr(CameraWatchLoop.#lastOcrAt, now, CameraWatchLoop.#lastDigest, digest)) {
			return undefined;
		}
		CameraWatchLoop.#lastOcrAt = now;
		CameraWatchLoop.#lastDigest = digest;
		try {
			const ocr = await ocrFrame(keepPath, { lang: "eng" });
			return ocr.text || undefined;
		} catch {
			return undefined;
		}
	}

	/** Sweep older live-watch steers so a long watch stays at ~1 OCR steer in context. */
	static async #sweepSteers(): Promise<void> {
		try {
			CameraWatchLoop.#ocrSwept += (await CameraWatchLoop.#session?.dropLiveWatchImages?.()) ?? 0;
		} catch {}
	}

	static async #steerOcr(text: string, at: number): Promise<void> {
		// Rolling 60s cap on hidden steer spam.
		const now = Date.now();
		if (now - CameraWatchLoop.#steerWindowStart > 60_000) {
			CameraWatchLoop.#steerWindowStart = now;
			CameraWatchLoop.#steerCount = 0;
		}
		if (CameraWatchLoop.#steerCount >= WATCH_STEER_MAX_PER_MINUTE) return;
		CameraWatchLoop.#steerCount++;
		const trimmed = text.length > WATCH_APPEND_STEER_MAX_CHARS ? `${text.slice(0, WATCH_APPEND_STEER_MAX_CHARS)}…` : text;
		await CameraWatchLoop.#sweepSteers();
		const content = [
			{ type: "text", text: `[watch] screen now reads (${text.length} chars):\n${trimmed}` },
		];
		try {
			await CameraWatchLoop.#session?.sendCustomMessage?.(
				{
					customType: "live-watch",
					content,
					display: false,
					details: { watchOcr: { at, chars: text.length } },
					attribution: "agent",
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
		} catch {}
	}
	/** Append-mode stream: hidden steer carrying only the newly-visible OCR
	 *  delta, delivered unswept (customType live-watch-append so the latest-only
	 *  sweep in dropLiveWatchImages never removes accumulated readings). Bounded
	 *  by the same WATCH_TRANSCRIPT_MAX_CHARS budget as the in-memory book. */
	static async #steerAppendOcr(text: string, at: number): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		const clipped = trimmed.length > WATCH_APPEND_STEER_MAX_CHARS ? `${trimmed.slice(0, WATCH_APPEND_STEER_MAX_CHARS)}…` : trimmed;
		if (CameraWatchLoop.#appendStreamChars + clipped.length > WATCH_TRANSCRIPT_MAX_CHARS) {
			CameraWatchLoop.#appendStreamOverflow = true;
			CameraWatchLoop.#appendStreamDropped++;
			return;
		}
		const content = [{ type: "text", text: `[watch append] newly visible (${text.length} chars):\n${clipped}` }];
		const session = CameraWatchLoop.#session;
		if (!session?.sendCustomMessage) return;
		try {
			await session.sendCustomMessage(
				{
					customType: "live-watch-append",
					content,
					display: false,
					details: { watchAppend: { at, chars: text.length } },
					attribution: "agent",
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
			CameraWatchLoop.#appendStreamChars += clipped.length;
	} catch {}
	}

	static async #tick(): Promise<void> {
		CameraWatchLoop.#tickNumber++;
		// Screen lane — capture to a keep-file so OCR can read it, with a cheap
		// digest gate so a static screen (idle desktop, paused video) costs ~0.
		if (CameraWatchLoop.#lanes !== "camera" && !CameraWatchLoop.#screenBusy) {
			CameraWatchLoop.#screenBusy = true;
			const generation = CameraWatchLoop.#generation;
			const stamp = Date.now();
			const keepPath = path.join(os.tmpdir(), `aerys-watch-${stamp}.jpg`);
			void captureScreenFrame({ target: "fullscreen", quality: 60, timeoutMs: 800, keepFile: true })
				.then(async v => {
					if (generation !== CameraWatchLoop.#generation) return; // stopped or restarted mid-flight
					if (!v.image) {
						CameraWatchLoop.#push({ kind: "screen", at: stamp, note: "screen capture empty" });
						return;
					}
					// keepFile:true retains the capture at v.filePath; the locally
					// constructed keepPath was never written by screen-vision.
					const ocrPath = v.filePath ?? keepPath;
					const digest = CameraWatchLoop.#digestOf(Buffer.from(v.image.data, "base64"));
					const at = Date.now();
					const ocrText = await CameraWatchLoop.#maybeOcr(ocrPath, digest);
					if (v.filePath) {
						try {
							fs.rmSync(v.filePath, { force: true });
						} catch {}
					}
					CameraWatchLoop.#push({
						kind: "screen",
						at,
						note: ocrText ? `screen ${v.image.data.length}B · ocr ${ocrText.length} chars` : `screen ${v.image.data.length}B`,
						ocr: ocrText,
						digest,
					});
					if (ocrText) {
						// Every watch reading joins the transcript (durable book),
						// not just in append mode — the ephemeral live-watch steer
						// is swept within a turn or two, so without this the full
						// text would be unrecoverable after the next delta.
						CameraWatchLoop.#appendTranscript(ocrText, "watch");
						if (CameraWatchLoop.#appendMode) {
							const delta = watchLineDelta(CameraWatchLoop.#lastReadText, ocrText);
							CameraWatchLoop.#lastReadText = ocrText;
							if (delta) await CameraWatchLoop.#steerAppendOcr(delta, at);
						}
						await CameraWatchLoop.#steerOcr(ocrText, at);
					}
				})
				.catch(() => {})
				.finally(() => {
					fs.rmSync(keepPath, { force: true });
					CameraWatchLoop.#screenBusy = false;
				});
		}
		// Camera lane — slower: face snapshot + identification every 5s.
		if (CameraWatchLoop.#lanes !== "screen" && CameraWatchLoop.#tickNumber % (WATCH_CAMERA_INTERVAL_MS / WATCH_SCREEN_INTERVAL_MS) === 0 && !CameraWatchLoop.#cameraBusy) {
			CameraWatchLoop.#cameraBusy = true;
			const generation = CameraWatchLoop.#generation;
			try {
				const { stdout } = await execFileAsync(
					DEFAULT_VENV_PYTHON,
					[DEFAULT_WORKER, "--device", "/dev/video0", "--resolution", "640x480", "--identify", "--score-threshold", "0.2"],
					{ timeout: 15_000 },
				);
				if (generation !== CameraWatchLoop.#generation) return; // stopped or restarted mid-flight
				const parsed = JSON.parse(stdout) as WorkerResult;
				const idents = (parsed.faces ?? []).map(f => f.identity?.name ?? "face").join(", ");
				CameraWatchLoop.#push({
					kind: "camera",
					at: Date.now(),
					faces: parsed.faces?.length ?? 0,
					note: idents || undefined,
				});
			} finally {
				CameraWatchLoop.#cameraBusy = false;
			}
		}
	}

	static #push(frame: WatchFrame): void {
		CameraWatchLoop.#frames.push(frame);
		if (CameraWatchLoop.#frames.length > WATCH_MAX_FRAMES) {
			CameraWatchLoop.#frames.shift();
		}
	}

	/** Append a distinct OCR reading to the transcript (deduped against the
	 *  previous entry — scrolling a book re-reads the same page several times).
	 *  Oldest entries are trimmed once the char budget is exceeded. */
	static #appendTranscript(text: string, source?: string): boolean {
		const trimmed = text.trim();
		if (trimmed.length < 3) return false;
		const prev = CameraWatchLoop.#transcript[CameraWatchLoop.#transcript.length - 1];
		if (prev && prev.text === trimmed) return false;
		// Also skip if this reading is contained in the previous one (partial scroll overlap).
		if (prev && prev.text.includes(trimmed)) {
			return false;
		}
		CameraWatchLoop.#transcript.push({ at: Date.now(), text: trimmed, ...(source ? { source } : {}) });
		let total = CameraWatchLoop.#transcript.reduce((n, e) => n + e.text.length + 1, 0);
		while (total > WATCH_TRANSCRIPT_MAX_CHARS && CameraWatchLoop.#transcript.length > 1) {
			const oldest = CameraWatchLoop.#transcript.shift();
			if (oldest) total -= oldest.text.length + 1;
		}
		return true;
	}

	/** Record an OCR reading from OUTSIDE the watch loop (eye glance,
	 *  screenshot, live-verify frame). The ephemeral image sweeps wipe the
	 *  steer copy within a turn or two, so the transcript is the durable copy
	 *  the model re-reads via watch_transcript. Works whether or not a watch
	 *  is running — the book outlives any single session. Full untruncated
	 *  text is stored; only the hidden-steer delivery is clipped. */
	static recordExternalOcr(text: string, source: string): boolean {
		return CameraWatchLoop.#appendTranscript(text, source);
	}

	/** Number of transcript entries (test hook). */
	static get transcriptEntries(): number {
		return CameraWatchLoop.#transcript.length;
	}

	static handle(action: string, append?: boolean, lanes: "both" | "screen" | "camera" = "both"): AgentToolResult {
		if (action === "watch_start") {
			CameraWatchLoop.start(append ?? false, lanes);
			const mode = append ? " + APPEND mode (every distinct reading joins the transcript)" : "";
			const lane =
				lanes === "both"
					? `screen ~1fps + OCR on change + camera face snapshots every ${WATCH_CAMERA_INTERVAL_MS / 1000}s`
					: lanes === "screen"
						? "screen ~1fps + OCR on change (camera lane disabled)"
						: `camera face snapshots every ${WATCH_CAMERA_INTERVAL_MS / 1000}s (screen lane disabled)`;
			return {
				content: [
					{
						type: "text",
						text: `Live watch started (${lane})${mode}. Use 'watch_status' to summarize, 'watch_transcript' to read the accumulated book, 'watch_stop' to end.`,
					},
				],
			};
		}
		if (action === "watch_stop") {
			const frames = CameraWatchLoop.#frames.length;
			const entries = CameraWatchLoop.#transcript.length;
			const chars = CameraWatchLoop.#transcript.reduce((n, e) => n + e.text.length, 0);
			CameraWatchLoop.stop();
			return {
				content: [
					{
						type: "text",
						text: `Live watch stopped (${frames} frame(s), transcript: ${entries} reading(s) / ${chars} chars — read via 'watch_transcript').`,
					},
				],
			};
		}
		if (action === "watch_transcript") {
			if (CameraWatchLoop.#transcript.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Transcript is empty. Start a watch with append:true ('watch_start' + append=true), let it read while you scroll or watch, then call 'watch_transcript'.",
						},
					],
				};
			}
		const chars = CameraWatchLoop.#transcript.reduce((n, e) => n + e.text.length, 0);
		const body = CameraWatchLoop.#transcript.map(e => `[${new Date(e.at).toLocaleTimeString()}${e.source ? ` ${e.source}` : ""}] ${e.text}`).join("\n\n");
			const streamSummary = CameraWatchLoop.#appendStreamOverflow
				? `, append stream capped at ${WATCH_TRANSCRIPT_MAX_CHARS} chars (${CameraWatchLoop.#appendStreamDropped} delta(s) dropped)`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Accumulated watch transcript — ${CameraWatchLoop.#transcript.length} reading(s), ${chars} chars (cap ${WATCH_TRANSCRIPT_MAX_CHARS}, oldest trimmed; ${CameraWatchLoop.#appendStreamChars} chars streamed to context${streamSummary}):\n\n${body}`,
					},
				],
				details: {
					entries: CameraWatchLoop.#transcript.length,
					chars,
					streamedChars: CameraWatchLoop.#appendStreamChars,
					overflowed: CameraWatchLoop.#appendStreamOverflow,
					dropped: CameraWatchLoop.#appendStreamDropped,
				},
			};
		}
		if (action === "watch_clear") {
			const had = CameraWatchLoop.#transcript.length;
			CameraWatchLoop.#transcript = [];
			CameraWatchLoop.#lastReadText = undefined;
			CameraWatchLoop.#appendStreamChars = 0;
			CameraWatchLoop.#appendStreamOverflow = false;
			CameraWatchLoop.#appendStreamDropped = 0;
			return {
				content: [{ type: "text", text: `Transcript cleared (${had} reading(s) discarded).` }],
			};
		}
		// watch_status
		if (!CameraWatchLoop.running) {
			return {
				content: [{ type: "text", text: "Live watch is not running. Start it with 'watch_start'." }],
			};
		}
		const frames = CameraWatchLoop.#frames;
		const screens = frames.filter(f => f.kind === "screen").length;
		const ocrFrames = frames.filter(f => f.kind === "screen" && f.ocr);
		const lastOcr = ocrFrames[ocrFrames.length - 1];
		const cams = frames.filter(f => f.kind === "camera" && (f.faces ?? 0) > 0);
		const lastCam = cams[cams.length - 1];
		const secs = Math.round((Date.now() - (CameraWatchLoop.#startedAt ?? Date.now())) / 1000);
		const who = lastCam?.note ?? "no face seen yet";
		const lanePart =
			CameraWatchLoop.#lanes === "screen"
				? " — screen-only watch (camera lane disabled)"
				: CameraWatchLoop.#lanes === "camera"
					? " — camera-only watch (screen lane disabled)"
					: "";
		const lines = [
			`Live watch running for ${secs}s${lanePart} — ${screens} screen frame(s), ${ocrFrames.length} OCR read(s)` +
				` (swept ${CameraWatchLoop.#ocrSwept}), camera: ${lastCam ? `${lastCam.faces} face(s) [${who}]` : "none yet"}.`,
		];
		if (lastOcr?.ocr) {
			// Full latest reading rides in details.lastOcr AND inline here — the
			// model re-reads exact text (e.g. an email body) instead of a slice.
			lines.push(`Latest on-screen text (${lastOcr.ocr.length} chars, full — also in watch_transcript):`);
			lines.push(lastOcr.ocr);
		} else {
			lines.push("No screen text read yet (screen unchanged since start, or OCR pending).");
		}
		const live = CameraWatchLoop.#frames;
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				running: true,
				secs,
				screenFrames: live.filter(f => f.kind === "screen").length,
				ocrFrames: live.filter(f => f.kind === "screen" && f.ocr).length,
				ocrSwept: CameraWatchLoop.#ocrSwept,
				cameraFrames: live.filter(f => f.kind === "camera" && (f.faces ?? 0) > 0).length,
				lastCamera: lastCam ? { faces: lastCam.faces, note: lastCam.note } : undefined,
				lastOcr: lastOcr?.ocr,
				lastOcrAt: lastOcr?.at,
			},
		};
	}
}

 export class CameraControlTool implements AgentTool<typeof cameraControlSchema> {
	readonly name = "camera_control";
	readonly approval = "read" as const;
	readonly label = "Camera Control";
	readonly description =
		"Webcam and screen camera tool. Captures webcam frames with on-device face detection (YuNet) and face recognition (SFace), records webcam or screen video to mp4, and runs a live-watch loop (screen OCR reads on change while you work + camera face snapshots). Fully local — no data leaves the machine.";
	readonly parameters = cameraControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary =
		"Camera: webcam capture, face recognition (who), record webcam/screen video, live-watch mode";

	static createIf(session: ToolSession): CameraControlTool | null {
		return new CameraControlTool(session);
	}

	#session?: ToolSession;

	constructor(session?: ToolSession) {
		this.#session = session;
	}

	async execute(_id: string, params: CameraControlParams): Promise<AgentToolResult> {
		const action = params.action ?? "capture";

		if (action === "list_devices") {
			const devices = findDeviceCandidates().filter(dev => {
				try {
					return fs.existsSync(dev);
				} catch {
					return false;
				}
			});
			return {
				content: [
					{
						type: "text",
						text: devices.length
							? `Available camera devices: ${devices.join(", ")}`
							: "No camera devices found under /dev/video*.",
					},
				],
			};
		}

		if (action === "enroll_face" || action === "identify" || action === "list_profiles") {
			return this.#faceIdentity(action, params);
		}
		if (action === "capture") {
			return this.#capture(params);
		}
		if (action === "record") {
			return this.#recordWebcam(params);
		}
		if (action === "record_screen") {
			return this.#recordScreen(params);
		}
		// watch actions — the loop steers via the session's hidden steer sink.
		CameraWatchLoop.attachSession(this.#session);
		return CameraWatchLoop.handle(action, params.append, params.lanes);
	}

	/** Build worker args for a standard capture. */
	#workerArgs(params: CameraControlParams, mode: "detect" | "identify" | "enroll"): string[] {
		const device = params.device ?? "/dev/video0";
		const resolution = params.resolution ?? "1280x720";
		const args = [DEFAULT_WORKER, "--device", device, "--resolution", resolution];
		if (mode === "identify") {
			args.push("--identify", "--score-threshold", "0.2");
		} else if (mode === "enroll") {
			args.push("--enroll", String(params.name ?? "user"), "--score-threshold", "0.2");
		} else if (params.face_detection ?? true) {
			args.push("--face-detect", "--score-threshold", "0.3");
		}
		return args;
	}

	async #runWorker(args: string[]): Promise<WorkerResult> {
		const venvPython = DEFAULT_VENV_PYTHON;
		try {
			const { stdout } = await execFileAsync(venvPython, args, { timeout: 30_000 });
			return JSON.parse(stdout) as WorkerResult;
		} catch (err) {
			throw new Error(
				`Camera worker failed: ${String(err)}. Is the webcam free and the runtime at ${CAMERA_DIR} installed?`,
			);
		}
	}

	async #faceIdentity(action: string, params: CameraControlParams): Promise<AgentToolResult> {
		if (action === "list_profiles") {
			const dir = path.join(CAMERA_DIR, "profiles");
			try {
				const names = fs
					.readdirSync(dir)
					.filter(f => f.endsWith(".npy"))
					.map(f => f.slice(0, -4));
				return {
					content: [
						{
							type: "text",
							text: names.length
								? `Enrolled faces: ${names.join(", ")}`
								: "No faces enrolled yet. Use action 'enroll_face' with a 'name' while the person is in frame.",
						},
					],
				};
			} catch {
				return {
					content: [{ type: "text", text: "No faces enrolled yet (profiles dir missing)." }],
				};
			}
		}

		if (action === "enroll_face") {
			if (!params.name) {
				return {
					content: [
						{ type: "text", text: "Provide a 'name' to enroll (e.g. the user's name)." },
					],
				};
			}
			const result = await this.#runWorker(this.#workerArgs(params, "enroll"));
			const enroll = result.enroll;
			if (!enroll?.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Enrollment failed: ${enroll?.error ?? result.error ?? "unknown error"}. Ask the person to look at the webcam and try again.`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Enrolled face '${params.name}' (${enroll.facesInFrame ?? 1} face(s) in frame). Future 'identify' calls will match this person.`,
					},
				],
			};
		}

		// identify
		const result = await this.#runWorker(this.#workerArgs(params, "identify"));
		if (result.error) {
			return { content: [{ type: "text", text: `Identify failed: ${result.error}` }] };
		}
		const faces = result.faces ?? [];
		if (faces.length === 0) {
			return { content: [{ type: "text", text: "No faces visible in the webcam frame right now." }] };
		}
		const lines = faces.map(f => {
			const id = f.identity;
			const who = id ? `${id.name} (similarity ${id.similarity})` : "unidentified (no profiles)";
			return `  Face at ${f.x},${f.y} ${f.w}x${f.h} — ${who}`;
		});
		return {
			content: [
				{
					type: "text",
					text: `I can see ${faces.length} face(s):\n${lines.join("\n")}`,
				},
				...(params.include_image ?? true
					? [
							{
								type: "image" as const,
								data: result.capture?.jpeg ?? "",
								mimeType: "image/jpeg",
							},
						]
					: []),
			],
			details: { faces },
		};
	}

	async #capture(params: CameraControlParams): Promise<AgentToolResult> {
		const device = params.device ?? "/dev/video0";
		const resolution = params.resolution ?? "1280x720";
		const faceDetection = params.face_detection ?? true;
		const includeImage = params.include_image ?? true;
		const args = this.#workerArgs(params, "detect");
		let ocrText = "";
		let ocrError: string | undefined;
		let ocrMode: "native" | "upscaled" | undefined;
		let result: WorkerResult;
		try {
			result = await this.#runWorker(args);
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `${String(err)} You can try a different device with "device": "/dev/video1".`,
					},
				],
			};
		}
		if (result.error) {
			return { content: [{ type: "text", text: `Webcam capture failed: ${result.error}` }] };
		}
		const capture = result.capture;
		if (!capture) {
			return { content: [{ type: "text", text: "Webcam capture returned no frame." }] };
		}
		if (params.ocr) {
			// OCR runs on the captured frame via ocrFrame (single-threaded tesseract:
			// OMP_THREAD_LIMIT=1 — multi-threaded hangs 30s+ on this box).
			const framePath = `/tmp/aerys-cam-frame-${Date.now()}.jpg`;
			fs.writeFileSync(framePath, Buffer.from(capture.jpeg, "base64"));
			try {
				const ocr = await ocrFrame(framePath, { lang: params.ocrLang });
				ocrText = ocr.text;
				ocrError = ocr.error;
				ocrMode = ocr.mode;
			} catch (err) {
				ocrError = String(err);
			} finally {
				fs.rmSync(framePath, { force: true });
			}
		}
		const [width, height] = capture.size;
		const faces = result.faces ?? [];
		let text = `Captured webcam frame from ${capture.device} (${width}x${height}) in ${capture.latencyMs}ms.`;
		if (faceDetection) {
			text += ` Face detection found ${faces.length} face(s) in ${result.detectionTimeMs}ms.`;
			if (faces.length > 0) {
				text += faces
					.map(
						f =>
							`\n  Face ${f.x},${f.y} ${f.w}x${f.h} (confidence ${Math.round(f.confidence * 100) / 100})`,
					)
					.join("");
				text += "\nCoordinates are in image pixels, origin top-left.";
			}
		} else {
			text += " Face detection was skipped.";
		}
		if (ocrText) {
			text += `\n\nIn-frame text (${ocrText.length} chars, tesseract ${ocrMode ?? "native"}):\n`;
			text += ocrText.length > 8000 ? `${ocrText.slice(0, 8000)}\n…[truncated]` : ocrText;
		} else if (params.ocr && ocrError) {
			text += `\n\nOCR failed: ${ocrError}`;
		} else if (params.ocr) {
			text += "\n\nOCR produced no text (frame may contain no readable text).";
		}
		return {
			content: [
				{ type: "text", text },
				...(includeImage
					? [
							{
								type: "image" as const,
								data: capture.jpeg,
								mimeType: "image/jpeg",
							},
						]
					: []),
			],
			details: {
				device: capture.device,
				size: [width, height],
				latencyMs: capture.latencyMs,
				faces,
				detectionTimeMs: faceDetection ? result.detectionTimeMs : undefined,
			},
		};
	}

	async #recordWebcam(params: CameraControlParams): Promise<AgentToolResult> {
		const duration = Math.min(Math.max(params.duration ?? 5, 1), 60);
		const device = params.device ?? "/dev/video0";
		const outPath = `/tmp/aerys-cam-${Date.now()}.mp4`;
		try {
			await execFileAsync(
				"ffmpeg",
				[
					"-hide_banner", "-loglevel", "error",
					"-f", "v4l2", "-input_format", "mjpeg",
					"-video_size", params.resolution ?? "1280x720",
					"-i", device,
					"-t", String(duration),
					"-c:v", "libx264", "-preset", "ultrafast", "-y",
					outPath,
				],
				{ timeout: (duration + 15) * 1000 },
			);
		} catch (err) {
			return { content: [{ type: "text", text: `Webcam recording failed: ${String(err)}` }] };
		}
		const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
		return {
			content: [
				{ type: "text", text: `Recorded ${duration}s webcam video → ${outPath} (${Math.round(size / 1024)}KB, H.264).` },
			],
			details: { file: outPath, durationSec: duration, bytes: size },
		};
	}

	async #recordScreen(params: CameraControlParams): Promise<AgentToolResult> {
		const duration = Math.min(Math.max(params.duration ?? 5, 1), 60);
		const outPath = `/tmp/aerys-screen-${Date.now()}.mp4`;
		const started = Date.now();
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn("wf-recorder", ["-c", "libx264", "-f", outPath], {
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr?.on("data", (d: Buffer) => {
					stderr += d.toString();
				});
				const t = setTimeout(() => {
					child.kill("SIGINT"); // wf-recorder finalizes the mp4 on SIGINT
				}, duration * 1000);
				child.on("exit", code => {
					clearTimeout(t);
					if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) resolve();
					else reject(new Error(`wf-recorder exited ${code}; ${stderr.slice(-300)}`));
		});
				child.on("error", reject);
			});
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Screen recording failed: ${String(err)}. Is wf-recorder installed (pacman -S wf-recorder) and is this a Hyprland/wlroots session?`,
					},
				],
			};
		}
		const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
		return {
			content: [
				{
					type: "text",
					text: `Recorded ${Math.round((Date.now() - started) / 1000)}s of screen → ${outPath} (${Math.round(size / 1024)}KB).`,
				},
			],
			details: { file: outPath, durationSec: duration, bytes: size },
		};
	}
}