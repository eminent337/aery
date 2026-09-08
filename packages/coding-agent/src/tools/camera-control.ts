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

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";

const execFileAsync = promisify(execFile);

// Follows the established voice-assets pattern (speaker-id.ts / voice-engine.ts):
// runtime assets live outside the (byte-identical) TS repo.
const CAMERA_DIR = path.join(os.homedir(), ".local", "share", "aerys", "camera");

export interface DetectedFace {
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
}

const cameraControlSchema = z.object({
	action: z
		.enum(["capture", "list_devices"])
		.describe(
			"Action: 'capture' grabs a frame from the webcam (optionally running face detection), 'list_devices' lists available webcam devices.",
		),
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

interface WorkerResult {
	capture?: { device: string; size: [number, number]; jpeg: string; latencyMs: number };
	faces: DetectedFace[];
	detectionTimeMs: number;
	error?: string;
}

function findDeviceCandidates(): string[] {
	const candidates: string[] = [];
	for (let i = 0; i < 8; i++) {
		candidates.push(`/dev/video${i}`);
	}
	return candidates;
}

export class CameraControlTool implements AgentTool<typeof cameraControlSchema> {
	readonly name = "camera_control";
	readonly approval = "read" as const;
	readonly label = "Camera Control";
	readonly description =
		"Webcam capture and face-tracking tool. Captures a frame from the local webcam and optionally runs on-device face detection (OpenCV YuNet), returning the JPEG image plus detected face bounding boxes.";
	readonly parameters = cameraControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Webcam capture and face tracking (capture frames, detect faces)";

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

		// action === "capture"
		const device = params.device ?? "/dev/video0";
		const resolution = params.resolution ?? "1280x720";
		const faceDetection = params.face_detection ?? true;
		const includeImage = params.include_image ?? true;

		const workerPath = path.join(CAMERA_DIR, "bin", "face_detect.py");
		const venvPython = path.join(CAMERA_DIR, "venv", "bin", "python");

		const args = [
			workerPath,
			"--device",
			device,
			"--resolution",
			resolution,
		];
		if (faceDetection) {
			args.push("--face-detect", "--score-threshold", "0.3");
		}

		let result: WorkerResult;
		try {
			const { stdout } = await execFileAsync(venvPython, args, {
				timeoutMs: 20_000,
			});
			result = JSON.parse(stdout) as WorkerResult;
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Webcam capture failed: ${String(err)}. Is the camera available and not in use by another app? You can try a different device with "device": "/dev/video1".`,
					},
				],
			};
		}

		if (result.error) {
			return {
				content: [
					{
						type: "text",
						text: `Webcam capture failed: ${result.error}`,
					},
				],
			};
		}

		const capture = result.capture;
		if (!capture) {
			return {
				content: [{ type: "text", text: "Webcam capture returned no frame." }],
			};
		}

		const [width, height] = capture.size;
		const faces = result.faces ?? [];

		let text = `Captured webcam frame from ${capture.device} (${width}x${height}) in ${capture.latencyMs}ms.`;
		if (faceDetection) {
			text += ` Face detection found ${faces.length} face(s) in ${result.detectionTimeMs}ms.`;
			if (faces.length > 0) {
				text += faces
					.map(f =>
						`\n  Face ${f.x},${f.y} ${f.w}x${f.h} (confidence ${Math.round(f.confidence * 100) / 100})`,
					)
					.join("");
				text += "\nCoordinates are in image pixels, origin top-left.";
			}
		} else {
			text += " Face detection was skipped.";
		}

		const details: Record<string, unknown> = {
			device: capture.device,
			size: [width, height],
			latencyMs: capture.latencyMs,
			faces,
			detectionTimeMs: faceDetection ? result.detectionTimeMs : undefined,
		};

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
			details,
		};
	}
}