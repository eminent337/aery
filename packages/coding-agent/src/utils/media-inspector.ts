/**
 * Media Inspector — Multimodal Video and Audio Comprehension.
 * Ported from Google Antigravity (agy).
 *
 * Provides media format identification, structured stream metadata probing (via ffprobe),
 * keyframe extraction (via ffmpeg), and inspection notes for `read` and `inspect_image` tools.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBytes } from "@aryee337/aery-utils";

export const VIDEO_EXTENSIONS = new Set<string>([".mp4", ".mov", ".webm", ".ogv", ".mkv", ".avi"]);

export const AUDIO_EXTENSIONS = new Set<string>([".mp3", ".m4a", ".opus", ".wav", ".aac", ".flac", ".ogg"]);

export function isVideoExtension(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return VIDEO_EXTENSIONS.has(ext);
}

export function isAudioExtension(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return AUDIO_EXTENSIONS.has(ext);
}

export function isVideoOrAudioExtension(filePath: string): boolean {
	return isVideoExtension(filePath) || isAudioExtension(filePath);
}

export interface MediaMetadata {
	kind: "video" | "audio";
	format: string;
	mimeType: string;
	fileSize: number;
	durationSeconds?: number;
	durationFormatted?: string;
	// Video specific
	width?: number;
	height?: number;
	videoCodec?: string;
	fps?: number;
	hasAudio?: boolean;
	// Audio specific
	audioCodec?: string;
	channels?: number;
	sampleRate?: number;
	bitrateKbps?: number;
}

export interface ExtractedKeyframe {
	timestampSeconds: number;
	framePath: string;
	dataBase64: string;
}

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
	const mins = Math.floor(seconds / 60);
	const secs = (seconds % 60).toFixed(2);
	if (mins > 0) {
		return `${mins}m ${secs}s`;
	}
	return `${secs}s`;
}

/**
 * Probes a video or audio file for structured metadata using ffprobe.
 */
export async function inspectMediaFile(filePath: string): Promise<MediaMetadata> {
	const ext = path.extname(filePath).toLowerCase();
	const kind: "video" | "audio" = isVideoExtension(filePath) ? "video" : "audio";
	const stat = await fs.stat(filePath);

	const defaultMime = kind === "video" ? `video/${ext.slice(1)}` : `audio/${ext.slice(1)}`;
	const metadata: MediaMetadata = {
		kind,
		format: ext.slice(1),
		mimeType: defaultMime,
		fileSize: stat.size,
	};

	try {
		const probe = spawnSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate,duration",
				"-of",
				"json",
				filePath,
			],
			{ timeout: 15_000 },
		);

		if (probe.status === 0 && probe.stdout) {
			const parsed = JSON.parse(probe.stdout.toString()) as {
				format?: { format_name?: string; duration?: string; bit_rate?: string };
				streams?: Array<{
					index?: number;
					codec_type?: string;
					codec_name?: string;
					width?: number;
					height?: number;
					r_frame_rate?: string;
					channels?: number;
					sample_rate?: string;
					duration?: string;
				}>;
			};

			if (parsed.format?.format_name) {
				metadata.format = parsed.format.format_name;
			}

			const formatDurationSec = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : undefined;
			if (formatDurationSec && Number.isFinite(formatDurationSec) && formatDurationSec > 0) {
				metadata.durationSeconds = formatDurationSec;
				metadata.durationFormatted = formatDuration(formatDurationSec);
			}

			if (parsed.format?.bit_rate) {
				const bps = Number.parseInt(parsed.format.bit_rate, 10);
				if (!Number.isNaN(bps)) {
					metadata.bitrateKbps = Math.round(bps / 1000);
				}
			}

			const videoStream = parsed.streams?.find(s => s.codec_type === "video");
			const audioStream = parsed.streams?.find(s => s.codec_type === "audio");

			if (videoStream) {
				metadata.videoCodec = videoStream.codec_name;
				metadata.width = videoStream.width;
				metadata.height = videoStream.height;
				if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes("/")) {
					const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
					if (den && den > 0) {
						metadata.fps = Math.round((num / den) * 100) / 100;
					}
				}
				if (!metadata.durationSeconds && videoStream.duration) {
					const d = Number.parseFloat(videoStream.duration);
					if (Number.isFinite(d) && d > 0) {
						metadata.durationSeconds = d;
						metadata.durationFormatted = formatDuration(d);
					}
				}
			}

			if (audioStream) {
				metadata.hasAudio = true;
				metadata.audioCodec = audioStream.codec_name;
				metadata.channels = audioStream.channels;
				metadata.sampleRate = audioStream.sample_rate ? Number.parseInt(audioStream.sample_rate, 10) : undefined;
				if (!metadata.durationSeconds && audioStream.duration) {
					const d = Number.parseFloat(audioStream.duration);
					if (Number.isFinite(d) && d > 0) {
						metadata.durationSeconds = d;
						metadata.durationFormatted = formatDuration(d);
					}
				}
			}
		}
	} catch {
		// Fall back to basic stat metadata if ffprobe fails or is missing
	}

	return metadata;
}

/**
 * Extracts representative keyframes from a video using ffmpeg.
 */
export async function extractKeyframes(filePath: string, count: number = 3): Promise<ExtractedKeyframe[]> {
	if (!isVideoExtension(filePath)) return [];

	const metadata = await inspectMediaFile(filePath);
	const duration = metadata.durationSeconds && metadata.durationSeconds > 0 ? metadata.durationSeconds : 1.0;
	const outDir = path.join(os.tmpdir(), `aery-keyframes-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	await fs.mkdir(outDir, { recursive: true });

	const keyframes: ExtractedKeyframe[] = [];
	const intervals: number[] = [];

	if (count <= 1) {
		intervals.push(duration * 0.5);
	} else {
		for (let i = 1; i <= count; i++) {
			intervals.push((duration * i) / (count + 1));
		}
	}

	for (let idx = 0; idx < intervals.length; idx++) {
		const targetSec = intervals[idx];
		const framePath = path.join(outDir, `keyframe-${idx + 1}.png`);

		const child = spawnSync(
			"ffmpeg",
			["-y", "-ss", targetSec.toFixed(3), "-i", filePath, "-frames:v", "1", "-q:v", "2", framePath],
			{ timeout: 15_000 },
		);

		if (child.status === 0) {
			try {
				const buf = await fs.readFile(framePath);
				keyframes.push({
					timestampSeconds: Math.round(targetSec * 100) / 100,
					framePath,
					dataBase64: buf.toString("base64"),
				});
			} catch {
				// Continue if frame extraction for this interval failed
			}
		}
	}

	return keyframes;
}

/**
 * Formats structured media metadata into human and LLM-readable notes.
 */
export function formatMediaMetadataNote(metadata: MediaMetadata): string {
	const lines: string[] = [];
	if (metadata.kind === "video") {
		lines.push("Video metadata:");
		lines.push(`- Format: ${metadata.format}`);
		lines.push(`- Size: ${formatBytes(metadata.fileSize)}`);
		lines.push(
			`- Duration: ${metadata.durationFormatted ?? (metadata.durationSeconds ? `${metadata.durationSeconds}s` : "unknown")}`,
		);
		if (metadata.width && metadata.height) {
			lines.push(`- Dimensions: ${metadata.width}x${metadata.height}`);
		}
		if (metadata.videoCodec) {
			lines.push(`- Video Codec: ${metadata.videoCodec}${metadata.fps ? ` (${metadata.fps} fps)` : ""}`);
		}
		if (metadata.hasAudio) {
			lines.push(
				`- Audio: ${metadata.audioCodec ?? "yes"} (${metadata.channels ?? 2} channels${metadata.sampleRate ? `, ${metadata.sampleRate} Hz` : ""})`,
			);
		}
	} else {
		lines.push("Audio metadata:");
		lines.push(`- Format: ${metadata.format}`);
		lines.push(`- Size: ${formatBytes(metadata.fileSize)}`);
		lines.push(
			`- Duration: ${metadata.durationFormatted ?? (metadata.durationSeconds ? `${metadata.durationSeconds}s` : "unknown")}`,
		);
		if (metadata.audioCodec) {
			lines.push(`- Audio Codec: ${metadata.audioCodec}`);
		}
		if (metadata.channels !== undefined) {
			lines.push(`- Channels: ${metadata.channels}`);
		}
		if (metadata.sampleRate !== undefined) {
			lines.push(`- Sample Rate: ${metadata.sampleRate} Hz`);
		}
		if (metadata.bitrateKbps !== undefined) {
			lines.push(`- Bitrate: ${metadata.bitrateKbps} kbps`);
		}
	}

	return lines.join("\n");
}
