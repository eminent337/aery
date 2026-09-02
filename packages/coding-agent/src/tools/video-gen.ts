import * as os from "node:os";
import * as path from "node:path";
import { $env, ptree, Snowflake, untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import type { CustomTool } from "../extensibility/custom-tools/types";

/**
 * Video generation tool. Mirrors `image-gen.ts` but targets async queue
 * providers: submit a job, poll status until rendered, fetch the result, and
 * download the MP4. Providers are pluggable; fal.ai is implemented first —
 * its queue API is plain REST and hosts many models including open-weights
 * ones (Wan, LTX-Video). Contract mirrors fal's own JS client
 * (libs/client/src/queue.ts): POST https://queue.fal.run/{model-id}, then GET
 * status_url until `status: "OK"`, then GET response_url for the output.
 */

const VIDEO_SUBMIT_TIMEOUT_MS = 60_000;
const VIDEO_POLL_INTERVAL_MS = 3_000;
const VIDEO_MAX_WAIT_MS = 10 * 60 * 1000;
const VIDEO_MAX_TRANSIENT_STATUS_ERRORS = 5;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 3 * 60_000;

const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/wan-t2v";

const FAL_TERMINAL_STATUSES: Record<string, true> = { OK: true, COMPLETED: true, SUCCESS: true };

const VIDEO_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const VIDEO_DURATION_MIN = 3;
const VIDEO_DURATION_MAX = 15;

export type VideoProvider = "fal";

const videoGenSchema = z
	.object({
		subject: z.string().describe("what the video should show"),
		action: z.string().describe("what happens / motion in the scene").optional(),
		scene: z.string().describe("location or environment").optional(),
		style: z.string().describe("visual style (e.g. cinematic, anime, documentary)").optional(),
		duration: z
			.number()
			.int()
			.min(VIDEO_DURATION_MIN)
			.max(VIDEO_DURATION_MAX)
			.describe(`video length in seconds (${VIDEO_DURATION_MIN}-${VIDEO_DURATION_MAX})`)
			.optional(),
		aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).describe("aspect ratio of the video").optional(),
		model: z
			.string()
			.describe(
				"provider-specific model id (e.g. 'fal-ai/wan-t2v', 'fal-ai/ltx-video'). Optional; uses the provider default when omitted.",
			)
			.optional(),
		provider: z
			.enum(["auto", "fal"])
			.describe("video provider to use. 'auto' or omitted uses the automatically detected provider.")
			.optional(),
	})
	.strict();

export type VideoGenParams = z.infer<typeof videoGenSchema>;

export interface VideoGenToolDetails {
	provider: VideoProvider;
	model: string;
	videoCount: number;
	videoPaths: string[];
	videoUrls: string[];
	error?: string;
}

function assembleVideoPrompt(params: VideoGenParams): string {
	const parts: string[] = [params.subject];
	if (params.action) parts.push(params.action);
	if (params.scene) parts.push(params.scene);
	if (params.style) parts.push(`Style: ${params.style}`);
	return `${parts.join(", ")}.`;
}

function findFalKey(): string | undefined {
	return Bun.env.FAL_KEY ?? $env.FAL_KEY ?? undefined;
}

interface FalQueueSubmitResponse {
	request_id?: string;
	status_url?: string;
	response_url?: string;
	status?: string;
	error?: unknown;
	detail?: unknown;
}

interface FalQueueStatusResponse {
	status?: string;
	queue_position?: number;
	response_url?: string;
	error?: unknown;
	detail?: unknown;
}

interface FalVideoResult {
	video?: { url?: string };
	videos?: Array<{ url?: string }>;
	url?: string;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function submitFalJob(
	apiKey: string,
	model: string,
	params: VideoGenParams,
	signal?: AbortSignal,
): Promise<FalQueueSubmitResponse> {
	const body: Record<string, unknown> = { prompt: assembleVideoPrompt(params) };
	if (params.duration) body.duration = params.duration;
	if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;

	const response = await fetch(`${FAL_QUEUE_BASE_URL}/${model}`, {
		method: "POST",
		headers: {
			Authorization: `Key ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: ptree.combineSignals(signal, VIDEO_SUBMIT_TIMEOUT_MS),
	});
	const rawText = await response.text();
	let parsed: FalQueueSubmitResponse = {};
	try {
		parsed = JSON.parse(rawText) as FalQueueSubmitResponse;
	} catch {
		// Non-JSON error body — fall through to the status check below.
	}
	if (!response.ok) {
		const detail = typeof parsed.detail === "string" ? parsed.detail : rawText.slice(0, 300);
		throw new Error(`Video job submission failed (${response.status}): ${detail}`);
	}
	if (!parsed.status_url || !parsed.response_url) {
		throw new Error("Video job submission response missing status_url/response_url.");
	}
	return parsed;
}

/** Best-effort job cancellation when the user aborts mid-render. */
function cancelFalJob(apiKey: string, statusUrl: string): void {
	const requestUrl = statusUrl.replace(/\/status$/, "");
	void fetch(requestUrl, {
		method: "DELETE",
		headers: { Authorization: `Key ${apiKey}` },
	}).catch(() => {
		// Fire-and-forget: nothing useful to do if cancellation fails.
	});
}

async function pollFalStatus(
	apiKey: string,
	statusUrl: string,
	signal?: AbortSignal,
): Promise<{ done: boolean; responseUrl?: string; error?: string; note?: string }> {
	let response: Response;
	try {
		response = await fetch(statusUrl, {
			headers: { Authorization: `Key ${apiKey}` },
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		// Transient network blip while polling — report and keep waiting.
		return { done: false, error: error instanceof Error ? error.message : "status check failed" };
	}
	const rawText = await response.text();
	let parsed: FalQueueStatusResponse = {};
	try {
		parsed = JSON.parse(rawText) as FalQueueStatusResponse;
	} catch {
		parsed = {};
	}
	if (!response.ok) {
		return { done: false, error: `status ${response.status}` };
	}
	const status = (parsed.status ?? "").toUpperCase();
	if (FAL_TERMINAL_STATUSES[status]) {
		return { done: true, responseUrl: parsed.response_url };
	}
	if (status.includes("ERROR") || status.includes("FAILED")) {
		const detail = typeof parsed.detail === "string" ? parsed.detail : "render failed";
		return { done: true, error: detail };
	}
	const queued = parsed.queue_position !== undefined ? ` (queue position ${parsed.queue_position})` : "";
	return { done: false, note: status === "IN_PROGRESS" ? "rendering" : `in queue${queued}` };
}

function extractVideoUrl(result: FalVideoResult): string | undefined {
	return result.video?.url ?? result.videos?.find(v => v.url)?.url ?? result.url;
}

async function fetchFalResult(
	apiKey: string,
	responseUrl: string,
	signal?: AbortSignal,
): Promise<{ videoUrl: string }> {
	const response = await fetch(responseUrl, {
		headers: { Authorization: `Key ${apiKey}` },
		signal,
	});
	const rawText = await response.text();
	if (!response.ok) {
		throw new Error(`Video result fetch failed (${response.status}): ${rawText.slice(0, 200)}`);
	}
	let parsed: FalVideoResult;
	try {
		parsed = JSON.parse(rawText) as FalVideoResult;
	} catch {
		throw new Error("Video result was not valid JSON.");
	}
	const videoUrl = extractVideoUrl(parsed);
	if (!videoUrl) {
		throw new Error("Video result did not contain a video URL.");
	}
	return { videoUrl };
}

async function downloadVideo(url: string, signal?: AbortSignal): Promise<Uint8Array> {
	const response = await fetch(url, { signal: ptree.combineSignals(signal, VIDEO_DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`Video download failed (${response.status})`);
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.startsWith("image/")) {
		throw new Error("Provider returned an image instead of a video for this model.");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) {
		throw new Error("Video download returned no data.");
	}
	return bytes;
}

async function saveVideoToTemp(bytes: Uint8Array): Promise<string> {
	const filepath = path.join(os.tmpdir(), `aery-video-${Snowflake.next()}.mp4`);
	await Bun.write(filepath, bytes);
	return filepath;
}

function buildVideoSummary(
	provider: VideoProvider,
	model: string,
	videoPaths: string[],
	elapsedSeconds: number,
): string {
	return [
		`Provider: ${provider}`,
		`Model: ${model}`,
		`Rendered ${videoPaths.length} video(s) in ~${Math.round(elapsedSeconds)}s:`,
		...videoPaths.map(p => `  ${p}`),
	].join("\n");
}

export const videoGenTool: CustomTool<typeof videoGenSchema, VideoGenToolDetails> = {
	name: "generate_video",
	label: "GenerateVideo",
	strict: false,
	approval: "write",
	description: [
		"Generate a short video from a text description.",
		"",
		"Uses async queue providers: submits a render job, polls until it finishes",
		"(typically 1-5 minutes; progress updates are emitted while waiting), then",
		"saves the MP4 and returns its path.",
		"",
		"Available video models:",
		"- fal — fal-ai/wan-t2v (default), fal-ai/ltx-video, and other fal-ai/* video models",
		"  (requires FAL_KEY; fal.ai account → API keys)",
	].join("\n"),
	parameters: videoGenSchema,
	async execute(_toolCallId, params, onUpdate, ctx, signal) {
		void ctx;
		return untilAborted(signal, async () => {
			const apiKey = findFalKey();
			if (!apiKey) {
				throw new Error(
					"No video generation credentials found. Set FAL_KEY (fal.ai account → API keys) to enable video generation.",
				);
			}
			const provider: VideoProvider = "fal";
			const model = params.model ?? DEFAULT_FAL_VIDEO_MODEL;
			const startedAt = Date.now();

			const submitted = await submitFalJob(apiKey, model, params, signal);
			const statusUrl = submitted.status_url;
			const responseUrl = submitted.response_url;
			if (!statusUrl || !responseUrl) {
				throw new Error("Video job did not return queue URLs.");
			}

			try {
				let transientErrors = 0;
				for (;;) {
					if (Date.now() - startedAt > VIDEO_MAX_WAIT_MS) {
						throw new Error(
							`Video render exceeded ${Math.round(VIDEO_MAX_WAIT_MS / 60_000)} minutes — the queue may be congested. Try again or pick a different model.`,
						);
					}
					await untilAborted(signal, sleep(VIDEO_POLL_INTERVAL_MS));
					const status = await pollFalStatus(apiKey, statusUrl, signal);
					if (status.done) {
						if (status.error) {
							throw new Error(`Video generation failed: ${status.error}`);
						}
						break;
					}
					if (status.error) {
						transientErrors += 1;
						if (transientErrors >= VIDEO_MAX_TRANSIENT_STATUS_ERRORS) {
							throw new Error(
								`Video status check kept failing (${status.error}) — giving up. The job may still finish; check your fal.ai dashboard.`,
							);
						}
					} else {
						transientErrors = 0;
					}
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Video rendering… ${Math.round((Date.now() - startedAt) / 1000)}s elapsed — ${status.note ?? status.error ?? "waiting"}`,
							},
						],
						details: { provider, model, videoCount: 0, videoPaths: [], videoUrls: [] },
					});
				}

				const { videoUrl } = await fetchFalResult(apiKey, responseUrl, signal);
				const bytes = await downloadVideo(videoUrl, signal);
				const videoPath = await saveVideoToTemp(bytes);
				const elapsedSeconds = (Date.now() - startedAt) / 1000;

				return {
					content: [{ type: "text", text: buildVideoSummary(provider, model, [videoPath], elapsedSeconds) }],
					details: {
						provider,
						model,
						videoCount: 1,
						videoPaths: [videoPath],
						videoUrls: [videoUrl],
					},
				};
			} catch (error) {
				if (signal?.aborted) {
					cancelFalJob(apiKey, statusUrl);
				}
				throw error;
			}
		});
	},
};

/**
 * Build the video generation tool list. Returns an empty array when no video
 * provider credentials are configured so the tool simply is not offered.
 */
export async function getVideoGenTools(): Promise<Array<CustomTool<typeof videoGenSchema, VideoGenToolDetails>>> {
	if (!findFalKey()) return [];
	return [videoGenTool];
}
