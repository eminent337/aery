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
		])
		.describe(
			"Actions: 'capture' (frame + face detection), 'identify' (detect + WHO is in frame via enrolled face profiles), 'enroll_face' (register the person currently in frame under 'name'), 'list_profiles' (enrolled people), 'record' (webcam video mp4), 'record_screen' (screen video mp4, Hyprland/wf-recorder), 'watch_start'/'watch_stop'/'watch_status' (live-watch loop: periodic screen + camera snapshots while the user works), 'list_devices'.",
		),
	name: z
		.string()
		.optional()
		.describe("Identity name for 'enroll_face' (e.g. the user's name)."),
	duration: z
		.number()
		.optional()
		.describe("Seconds to record for 'record'/'record_screen' (default 5, max 60)."),
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
});

export type CameraControlParams = z.infer<typeof cameraControlSchema>;

interface IdentityMatch {
	name: string;
	similarity: number;
}

interface DetectedFace {
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
	identity?: IdentityMatch | null;
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
}

const WATCH_SCREEN_INTERVAL_MS = 1000;
const WATCH_CAMERA_INTERVAL_MS = 5000;
const WATCH_MAX_FRAMES = 60;

export class CameraWatchLoop {
	static #timer: ReturnType<typeof setInterval> | undefined;
	static #screenBusy = false;
	static #cameraBusy = false;
	static #frames: WatchFrame[] = [];
	static #startedAt: number | undefined;

	static get running(): boolean {
		return CameraWatchLoop.#timer !== undefined;
	}

	static start(): void {
		if (CameraWatchLoop.#timer !== undefined) return; // idempotent
		CameraWatchLoop.#startedAt = Date.now();
		CameraWatchLoop.#timer = setInterval(() => {
			void CameraWatchLoop.#tick();
		}, WATCH_SCREEN_INTERVAL_MS);
	}

	static stop(): void {
		if (CameraWatchLoop.#timer !== undefined) {
			clearInterval(CameraWatchLoop.#timer);
			CameraWatchLoop.#timer = undefined;
			CameraWatchLoop.#startedAt = undefined;
		}
	}

	static #tickNumber = 0;

	static async #tick(): Promise<void> {
		CameraWatchLoop.#tickNumber++;
		// Screen lane — reuse the existing screen-vision capture (cheap, grim/hyprctl).
		if (!CameraWatchLoop.#screenBusy) {
			CameraWatchLoop.#screenBusy = true;
			void captureScreenFrame({ target: "fullscreen", quality: 60, timeoutMs: 800 })
				.then(v => {
					CameraWatchLoop.#push({
						kind: "screen",
						at: Date.now(),
						note: v.image ? `screen ${v.image.data.length}B` : "screen capture empty",
					});
				})
				.catch(() => {})
				.finally(() => {
					CameraWatchLoop.#screenBusy = false;
				});
		}
		// Camera lane — slower: face snapshot + identification every 5s.
		if (CameraWatchLoop.#tickNumber % (WATCH_CAMERA_INTERVAL_MS / WATCH_SCREEN_INTERVAL_MS) === 0 && !CameraWatchLoop.#cameraBusy) {
			CameraWatchLoop.#cameraBusy = true;
			try {
				const { stdout } = await execFileAsync(
					DEFAULT_VENV_PYTHON,
					[DEFAULT_WORKER, "--device", "/dev/video0", "--resolution", "640x480", "--identify", "--score-threshold", "0.2"],
					{ timeoutMs: 15_000 },
				);
				const parsed = JSON.parse(stdout) as WorkerResult;
				const idents = (parsed.faces ?? []).map(f => f.identity?.name ?? "face").join(", ");
				CameraWatchLoop.#push({
					kind: "camera",
					at: Date.now(),
					faces: parsed.faces?.length ?? 0,
					note: idents || undefined,
				});
			} catch {
				CameraWatchLoop.#push({ kind: "camera", at: Date.now(), faces: -1, note: "camera busy/absent" });
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

	static handle(action: string): AgentToolResult {
		if (action === "watch_start") {
			CameraWatchLoop.start();
			return {
				content: [
					{
						type: "text",
						text: `Live watch started (screen ~1fps + camera face snapshots every ${WATCH_CAMERA_INTERVAL_MS / 1000}s). Use 'watch_status' to summarize, 'watch_stop' to end.`,
					},
				],
			};
		}
		if (action === "watch_stop") {
			const frames = CameraWatchLoop.#frames.length;
			CameraWatchLoop.stop();
			return {
				content: [{ type: "text", text: `Live watch stopped (${frames} frame(s) observed this session).` }],
			};
		}
		// watch_status
		if (!CameraWatchLoop.running) {
			return {
				content: [
					{ type: "text", text: "Live watch is not running. Start it with 'watch_start'." },
				],
			};
		}
		const frames = CameraWatchLoop.#frames;
		const screens = frames.filter(f => f.kind === "screen").length;
		const cams = frames.filter(f => f.kind === "camera" && f.faces > 0);
		const lastCam = cams[cams.length - 1];
		const secs = Math.round((Date.now() - (CameraWatchLoop.#startedAt ?? Date.now())) / 1000);
		const who = lastCam?.note ?? "no face seen yet";
		return {
			content: [
				{
					type: "text",
					text: `Live watch running for ${secs}s — ${screens} screen frame(s), last camera snapshot: ${lastCam ? `${lastCam.faces} face(s) [${who}]` : "none yet"}.`,
				},
			],
			details: { frames: frames.slice(-12) },
		};
	}
}

 export class CameraControlTool implements AgentTool<typeof cameraControlSchema> {
	readonly name = "camera_control";
	readonly approval = "read" as const;
	readonly label = "Camera Control";
	readonly description =
		"Webcam and screen camera tool. Captures webcam frames with on-device face detection (YuNet) and face recognition (SFace), records webcam or screen video to mp4, and runs a live-watch loop (screen snapshots + camera face identification) while the user works. Fully local — no data leaves the machine.";
	readonly parameters = cameraControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary =
		"Camera: webcam capture, face recognition (who), record webcam/screen video, live-watch mode";

	static createIf(_session: ToolSession): CameraControlTool | null {
		return new CameraControlTool();
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
		// watch actions
		return CameraWatchLoop.handle(action);
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
			const { stdout } = await execFileAsync(venvPython, args, { timeoutMs: 30_000 });
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
				{ timeoutMs: (duration + 15) * 1000 },
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