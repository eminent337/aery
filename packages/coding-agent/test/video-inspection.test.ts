import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@aryee337/aery-ai";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { InspectImageTool } from "../src/tools/inspect-image";
import { ReadTool } from "../src/tools/read";
import {
	AUDIO_EXTENSIONS,
	extractKeyframes,
	formatMediaMetadataNote,
	inspectMediaFile,
	isAudioExtension,
	isVideoExtension,
	isVideoOrAudioExtension,
	VIDEO_EXTENSIONS,
} from "../src/utils/media-inspector";

describe("Media Inspector & Video File Comprehension", () => {
	let tempDir: string;
	let sampleVideoPath: string;
	let sampleAudioPath: string;

	const testVisionModel: Model<"openai-responses"> = {
		id: "gpt-4o",
		name: "GPT-4o",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	function createMockSession(cwd: string): ToolSession {
		const settings = Settings.isolated();
		settings.setModelRole("vision", "openai/gpt-4o");
		return {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getModelString: () => "openai/gpt-4o",
			getActiveModelString: () => "openai/gpt-4o",
			settings,
			modelRegistry: {
				getAvailable: () => [testVisionModel],
				getApiKey: async () => "test-key",
			} as any,
		};
	}

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-test-"));
		sampleVideoPath = path.join(tempDir, "sample.mp4");
		sampleAudioPath = path.join(tempDir, "sample.mp3");

		if (!hasFFmpeg) return;

		// Generate a 1-second 320x240 test video with ffmpeg
		spawnSync(
			"ffmpeg",
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc=duration=1:size=320x240:rate=10",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				sampleVideoPath,
			],
			{ timeout: 15_000 },
		);

		// Generate a 1-second 44100Hz sine wave audio with ffmpeg
		spawnSync(
			"ffmpeg",
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=1000:duration=1",
				"-c:a",
				"libmp3lame",
				"-b:a",
				"128k",
				sampleAudioPath,
			],
			{ timeout: 15_000 },
		);
	});

	afterAll(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	const hasFFmpeg = Boolean(Bun.which("ffmpeg"));
	const itFFmpeg = hasFFmpeg ? it : it.skip;

	it("identifies supported video and audio extensions", () => {
		expect(VIDEO_EXTENSIONS.has(".mp4")).toBe(true);
		expect(VIDEO_EXTENSIONS.has(".mov")).toBe(true);
		expect(VIDEO_EXTENSIONS.has(".webm")).toBe(true);
		expect(VIDEO_EXTENSIONS.has(".ogv")).toBe(true);

		expect(AUDIO_EXTENSIONS.has(".mp3")).toBe(true);
		expect(AUDIO_EXTENSIONS.has(".m4a")).toBe(true);
		expect(AUDIO_EXTENSIONS.has(".opus")).toBe(true);
		expect(AUDIO_EXTENSIONS.has(".wav")).toBe(true);

		expect(isVideoExtension("clip.mp4")).toBe(true);
		expect(isVideoExtension("REC.MOV")).toBe(true);
		expect(isVideoExtension("test.webm")).toBe(true);
		expect(isVideoExtension("track.mp3")).toBe(false);

		expect(isAudioExtension("voice.m4a")).toBe(true);
		expect(isAudioExtension("audio.opus")).toBe(true);
		expect(isAudioExtension("song.mp3")).toBe(true);
		expect(isAudioExtension("clip.mp4")).toBe(false);

		expect(isVideoOrAudioExtension("recording.mp4")).toBe(true);
		expect(isVideoOrAudioExtension("sample.opus")).toBe(true);
		expect(isVideoOrAudioExtension("document.pdf")).toBe(false);
	});

	itFFmpeg("inspects video file metadata including dimensions, duration, and codec", async () => {
		const meta = await inspectMediaFile(sampleVideoPath);
		expect(meta.kind).toBe("video");
		expect(meta.format).toMatch(/mp4/i);
		expect(meta.width).toBe(320);
		expect(meta.height).toBe(240);
		expect(meta.durationSeconds).toBeGreaterThan(0.5);
		expect(meta.videoCodec).toBeDefined();

		const note = formatMediaMetadataNote(meta);
		expect(note).toContain("Video metadata:");
		expect(note).toContain("320x240");
		expect(note).toContain("Duration:");
	});

	itFFmpeg("inspects audio file metadata including duration and channels", async () => {
		const meta = await inspectMediaFile(sampleAudioPath);
		expect(meta.kind).toBe("audio");
		expect(meta.durationSeconds).toBeGreaterThan(0.5);
		expect(meta.audioCodec).toMatch(/mp3/i);

		const note = formatMediaMetadataNote(meta);
		expect(note).toContain("Audio metadata:");
		expect(note).toContain("Duration:");
	});

	itFFmpeg("extracts keyframes from video file for visual inspection", async () => {
		const keyframes = await extractKeyframes(sampleVideoPath, 2);
		expect(keyframes.length).toBeGreaterThan(0);
		expect(keyframes[0].framePath).toBeDefined();
		expect(keyframes[0].timestampSeconds).toBeGreaterThanOrEqual(0);
		expect(keyframes[0].dataBase64).toBeDefined();
		expect(keyframes[0].dataBase64.length).toBeGreaterThan(0);

		// Clean up extracted keyframe temp files
		for (const kf of keyframes) {
			await fs.rm(kf.framePath, { force: true });
		}
	});

	itFFmpeg("read tool returns structured metadata and inspect guidance for video and audio files", async () => {
		const session = createMockSession(tempDir);
		const readTool = new ReadTool(session);

		// Read video file
		const videoResult = await readTool.execute("call-1", { path: sampleVideoPath });
		expect(videoResult.content).toBeDefined();
		const videoText = (videoResult.content?.[0] as any)?.text ?? "";
		expect(videoText).toContain("Video metadata:");
		expect(videoText).toContain("320x240");
		expect(videoText).toContain("inspect_image");

		// Read audio file
		const audioResult = await readTool.execute("call-2", { path: sampleAudioPath });
		expect(audioResult.content).toBeDefined();
		const audioText = (audioResult.content?.[0] as any)?.text ?? "";
		expect(audioText).toContain("Audio metadata:");
		expect(audioText).toContain("sample.mp3");
	});

	itFFmpeg("inspect_image tool extracts video keyframes and passes them to the vision model", async () => {
		const session = createMockSession(tempDir);
		let capturedMessages: any[] = [];
		const completeSimpleStub = async (_model: any, request: any) => {
			capturedMessages = request.messages;
			return {
				content: [{ type: "text", text: "Video shows color test bars." }],
				stopReason: "stop",
			} as any;
		};

		const tool = new InspectImageTool(session, completeSimpleStub);
		const result = await tool.execute("call-3", {
			path: sampleVideoPath,
			question: "What is shown in this video clip?",
		});

		expect(result.content).toBeDefined();
		const replyText = (result.content?.[0] as any)?.text ?? "";
		expect(replyText).toBe("Video shows color test bars.");

		// Verify captured message included image keyframe(s) and prompt text
		expect(capturedMessages.length).toBe(1);
		const userContent = capturedMessages[0].content;
		const imageParts = userContent.filter((c: any) => c.type === "image");
		const textParts = userContent.filter((c: any) => c.type === "text");

		expect(imageParts.length).toBeGreaterThan(0);
		expect(textParts.length).toBe(1);
		expect(textParts[0].text).toContain("Video Inspection");
		expect(textParts[0].text).toContain("What is shown in this video clip?");
	});
});
