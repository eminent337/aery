import * as os from "node:os";
import * as path from "node:path";
import { $env, $envpos, ptree, Snowflake, untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import { isAuthenticated, type ModelRegistry } from "../config/model-registry";
import type { CustomTool } from "../extensibility/custom-tools/types";

/**
 * Video generation tool. Mirrors `image-gen.ts` but targets async queue
 * providers: submit a render job, poll status until finished, download the
 * MP4. Two providers:
 *
 * - agnes (default when available): the Agnes gateway exposes free video
 *   models (agnes-video-2.5-flash etc.) behind a Sora-style jobs API,
 *   live-verified: POST {baseUrl}/videos {model, prompt, mode: "text",
 *   seconds?} -> {id}; GET {baseUrl}/videos/{id} -> status in_progress|
 *   completed with progress and metadata.url. Uses the same API key as the
 *   chat/image custom provider, so no extra setup is needed.
 * - fal: POST https://queue.fal.run/{model} with "Key <FAL_KEY>" auth, GET
 *   status_url until status OK, GET response_url, download the video URL.
 */

const VIDEO_SUBMIT_TIMEOUT_MS = 60_000;
const VIDEO_POLL_INTERVAL_MS = $envpos("AERY_VIDEO_POLL_INTERVAL_MS", 10_000);
const VIDEO_MAX_WAIT_MS = 15 * 60 * 1000;
const VIDEO_MAX_TRANSIENT_STATUS_ERRORS = 5;
const VIDEO_MAX_SUBMIT_RETRIES = 3;
const VIDEO_SUBMIT_RETRY_DELAY_MS = 2_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 3 * 60_000;

const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/wan-t2v";
const DEFAULT_AGNES_VIDEO_MODEL = "agnes-video-2.5-flash";

const AGNES_BASE_URL_MARKER = "agnes-ai.com";

const FAL_TERMINAL_STATUSES: Record<string, true> = { OK: true, COMPLETED: true, SUCCESS: true };
const AGNES_TERMINAL_STATUSES: Record<string, true> = { completed: true, succeeded: true };
const AGNES_FAILED_STATUSES: Record<string, true> = { failed: true, error: true, cancelled: true };

const VIDEO_DURATION_MIN = 3;
const VIDEO_DURATION_MAX = 15;

export type VideoProvider = "agnes" | "fal";

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
		resolution: z
			.enum(["480P", "768P", "1080P", "2K"])
			.describe(
				"target resolution. Agnes renders 720P; other providers use their default. Omit for provider default.",
			)
			.optional(),
		ratio: z
			.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
			.describe("aspect ratio. Omit for provider default (16:9).")
			.optional(),
		model: z
			.string()
			.describe(
				"provider-specific model id (e.g. 'agnes-video-2.5-flash', 'fal-ai/wan-t2v'). Optional; uses the provider default when omitted.",
			)
			.optional(),
		provider: z
			.enum(["auto", "agnes", "fal"])
			.describe(
				"video provider to use. 'auto' or omitted prefers Agnes (free with the configured Agnes key), then fal (FAL_KEY).",
			)
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
	resolution?: string;
	durationSeconds?: number;
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

interface VideoCredentials {
	provider: VideoProvider;
	apiKey: string;
	model: string;
	baseUrl?: string;
}

/**
 * Resolve video credentials: Agnes first (free, uses the already-configured
 * custom provider key), then fal via FAL_KEY. Returns null when neither is
 * available so the tool is simply not registered.
 */
async function findVideoCredentials(
	modelRegistry: ModelRegistry | undefined,
	preferred: VideoGenParams["provider"],
	sessionId?: string,
): Promise<VideoCredentials | null> {
	const wantAgnes = preferred === "auto" || preferred === "agnes" || preferred === undefined;
	const wantFal = preferred === "auto" || preferred === "fal" || preferred === undefined;
	if (wantAgnes && modelRegistry) {
		const agnesModel = modelRegistry
			.getAll()
			.find(m => typeof m.baseUrl === "string" && m.baseUrl.includes(AGNES_BASE_URL_MARKER));
		if (agnesModel) {
			const apiKey = await modelRegistry.getApiKey(agnesModel, sessionId);
			if (isAuthenticated(apiKey) && typeof apiKey === "string") {
				return {
					provider: "agnes",
					apiKey,
					model: DEFAULT_AGNES_VIDEO_MODEL,
					baseUrl: agnesModel.baseUrl,
				};
			}
		}
	}

	if (wantFal) {
		const falKey = findFalKey();
		if (falKey) {
			return { provider: "fal", apiKey: falKey, model: DEFAULT_FAL_VIDEO_MODEL };
		}
	}

	return null;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Retry a transient submission failure (503 queue-full / 429 throttled) with
 * linear backoff, mirroring the status-poll transient-error tally. Non-transient
 * failures are rethrown immediately; after the last retry the caller's wrapper
 * produces the final "after N tries" error.
 */
async function retryTransientSubmit(attempt: number, error: Error, signal?: AbortSignal): Promise<void> {
	const status = /(^|[^0-9])(503|429)([^0-9]|$)/.exec(error.message)?.[2];
	if (!status) throw error;
	if (attempt >= VIDEO_MAX_SUBMIT_RETRIES) return;
	await untilAborted(signal, sleep(VIDEO_SUBMIT_RETRY_DELAY_MS * (attempt + 1)));
}

/** Return a short reason extracted from a submission error message. */
function submissionErrorDetail(error: unknown): string {
	const detail =
		error instanceof Error && error.message.startsWith("Video job submission failed")
			? error.message.replace("Video job submission failed", "").trim()
			: error instanceof Error
				? error.message
				: String(error);
	return detail || "unknown submission error";
}

// --- Agnes (Sora-style jobs API) ---

interface AgnesVideoSubmitResponse {
	id?: string;
	task_id?: string;
	video_id?: string;
	status?: string;
	error?: { message?: string };
	message?: string;
}

interface AgnesVideoStatusResponse {
	id?: string;
	status?: string;
	progress?: number;
	metadata?: { url?: string };
	error?: { message?: string };
	message?: string;
}

async function submitAgnesJob(
	credentials: VideoCredentials,
	params: VideoGenParams,
	signal?: AbortSignal,
): Promise<string> {
	const baseUrl = credentials.baseUrl?.replace(/\/+$/, "") ?? "";
	const body: Record<string, unknown> = {
		model: params.model ?? credentials.model,
		prompt: assembleVideoPrompt(params),
		mode: "text",
	};
	if (params.duration !== undefined) {
		body.seconds = String(params.duration);
	}
	const response = await fetch(`${baseUrl}/videos`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: ptree.combineSignals(signal, VIDEO_SUBMIT_TIMEOUT_MS),
	});
	const rawText = await response.text();
	let parsed: AgnesVideoSubmitResponse = {};
	try {
		parsed = JSON.parse(rawText) as AgnesVideoSubmitResponse;
	} catch {
		// Non-JSON error body — handled by the status check below.
	}
	if (!response.ok) {
		const detail = parsed.error?.message ?? parsed.message ?? rawText.slice(0, 300);
		throw new Error(`Video job submission failed (${response.status}): ${detail}`);
	}
	const jobId = parsed.id ?? parsed.task_id ?? parsed.video_id;
	if (!jobId) {
		throw new Error("Video job submission response missing a task id.");
	}
	return jobId;
}

async function pollAgnesStatus(
	credentials: VideoCredentials,
	jobId: string,
	signal?: AbortSignal,
): Promise<{ done: boolean; videoUrl?: string; error?: string; note?: string }> {
	const baseUrl = credentials.baseUrl?.replace(/\/+$/, "") ?? "";
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/videos/${jobId}`, {
			headers: { Authorization: `Bearer ${credentials.apiKey}` },
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		return { done: false, error: error instanceof Error ? error.message : "status check failed" };
	}
	const rawText = await response.text();
	let parsed: AgnesVideoStatusResponse = {};
	try {
		parsed = JSON.parse(rawText) as AgnesVideoStatusResponse;
	} catch {
		parsed = {};
	}
	if (!response.ok) {
		const detail = parsed.error?.message ?? parsed.message ?? `status ${response.status}`;
		// 404 on a fresh job can be an eventual-consistency blip; treat as transient.
		if (response.status === 404) {
			return { done: false, note: "waiting for job registration" };
		}
		return { done: false, error: detail };
	}
	const status = (parsed.status ?? "").toLowerCase();
	if (AGNES_TERMINAL_STATUSES[status]) {
		const videoUrl = parsed.metadata?.url;
		if (!videoUrl) {
			return { done: true, error: "job completed but no video URL was returned" };
		}
		return { done: true, videoUrl };
	}
	if (AGNES_FAILED_STATUSES[status]) {
		const detail = parsed.error?.message ?? parsed.message ?? "render failed";
		return { done: true, error: detail };
	}
	const progress = typeof parsed.progress === "number" ? ` ${parsed.progress}%` : "";
	return { done: false, note: `${status || "in progress"}${progress}` };
}

// --- fal (queue API, mirrors fal-js client/queue.ts) ---

interface FalQueueSubmitResponse {
	request_id?: string;
	status_url?: string;
	response_url?: string;
	detail?: unknown;
}

interface FalQueueStatusResponse {
	status?: string;
	queue_position?: number;
	response_url?: string;
	detail?: unknown;
}

interface FalVideoResult {
	video?: { url?: string };
	videos?: Array<{ url?: string }>;
	url?: string;
}

async function submitFalJob(
	credentials: VideoCredentials,
	params: VideoGenParams,
	signal?: AbortSignal,
): Promise<{ statusUrl: string; responseUrl: string }> {
	const model = params.model ?? credentials.model;
	const body: Record<string, unknown> = { prompt: assembleVideoPrompt(params) };
	if (params.duration !== undefined) {
		body.duration = params.duration;
	}
	const response = await fetch(`${FAL_QUEUE_BASE_URL}/${model}`, {
		method: "POST",
		headers: {
			Authorization: `Key ${credentials.apiKey}`,
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
		// Non-JSON error body — handled by the status check below.
	}
	if (!response.ok) {
		const detail = typeof parsed.detail === "string" ? parsed.detail : rawText.slice(0, 300);
		throw new Error(`Video job submission failed (${response.status}): ${detail}`);
	}
	if (!parsed.status_url || !parsed.response_url) {
		throw new Error("Video job submission response missing status_url/response_url.");
	}
	return { statusUrl: parsed.status_url, responseUrl: parsed.response_url };
}

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
	return { done: false, note: status === "IN_PROGRESS" ? `rendering${queued}` : `in queue${queued}` };
}

async function fetchFalVideoUrl(apiKey: string, responseUrl: string, signal?: AbortSignal): Promise<string> {
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
	const videoUrl = parsed.video?.url ?? parsed.videos?.find(v => v.url)?.url ?? parsed.url;
	if (!videoUrl) {
		throw new Error("Video result did not contain a video URL.");
	}
	return videoUrl;
}

// --- shared tail ---

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
		"(typically 1-3 minutes; progress updates are emitted while waiting), then",
		"saves the MP4 and returns its path.",
		"",
		"Available video models:",
		"- agnes — agnes-video-2.5-flash (default), agnes-video-2.5, agnes-video-v2.0",
		"  (free, uses the configured Agnes key)",
		"- fal — fal-ai/wan-t2v and other fal-ai/* video models",
		"  (requires FAL_KEY; fal.ai account → API keys)",
	].join("\n"),
	parameters: videoGenSchema,
	async execute(_toolCallId, params, onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const credentials = await findVideoCredentials(
				ctx.modelRegistry,
				params.provider,
				ctx.sessionManager.getSessionId(),
			);
			if (!credentials) {
				throw new Error(
					"No video generation credentials found. Add an Agnes provider with video models or set FAL_KEY (fal.ai account → API keys).",
				);
			}
			const model = params.model ?? credentials.model;
			const startedAt = Date.now();

			let jobNote: string | undefined;
			if (credentials.provider === "agnes") {
				if (!credentials.baseUrl) {
					throw new Error("Missing Agnes baseUrl for video generation.");
				}
				let submissionError: unknown;
				let jobId: string | undefined;
				for (let attempt = 0; attempt <= VIDEO_MAX_SUBMIT_RETRIES; attempt++) {
					try {
						jobId = await submitAgnesJob(credentials, { ...params, model }, signal);
						submissionError = undefined;
						break;
					} catch (error) {
						submissionError = error;
						// Transient 503/429 (e.g. "video queue is full, retry later")
						// backs off and retries; anything else rethrows immediately.
						await retryTransientSubmit(attempt, error as Error, signal);
					}
				}
				if (!jobId || submissionError) {
					throw new Error(
						`Video job submission failed after ${VIDEO_MAX_SUBMIT_RETRIES + 1} tries: ${submissionErrorDetail(submissionError)}`,
					);
				}
				let transientErrors = 0;
				for (;;) {
					if (Date.now() - startedAt > VIDEO_MAX_WAIT_MS) {
						throw new Error(
							`Video render exceeded ${Math.round(VIDEO_MAX_WAIT_MS / 60_000)} minutes — the queue may be congested. Try again or pick a different model.`,
						);
					}
					await untilAborted(signal, sleep(VIDEO_POLL_INTERVAL_MS));
					const status = await pollAgnesStatus(credentials, jobId, signal);
					if (status.done) {
						if (status.error) {
							throw new Error(`Video generation failed: ${status.error}`);
						}
						const bytes = await downloadVideo(status.videoUrl as string, signal);
						const videoPath = await saveVideoToTemp(bytes);
						const elapsedSeconds = (Date.now() - startedAt) / 1000;
						return {
							content: [
								{
									type: "text",
									text: buildVideoSummary(credentials.provider, model, [videoPath], elapsedSeconds),
								},
							],
							details: {
								provider: credentials.provider,
								model,
								videoCount: 1,
								videoPaths: [videoPath],
								videoUrls: [status.videoUrl as string],
								resolution: "720P",
								durationSeconds: params.duration,
							},
						};
					}
					if (status.error) {
						transientErrors += 1;
						if (transientErrors >= VIDEO_MAX_TRANSIENT_STATUS_ERRORS) {
							throw new Error(`Video status check kept failing (${status.error}) — giving up.`);
						}
					} else {
						transientErrors = 0;
					}
					if (status.note !== jobNote) {
						jobNote = status.note;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Video rendering… ${Math.round((Date.now() - startedAt) / 1000)}s elapsed — ${status.note ?? status.error ?? "waiting"}`,
								},
							],
							details: { provider: credentials.provider, model, videoCount: 0, videoPaths: [], videoUrls: [] },
						});
					}
				}
			}

			// fal branch
			let submissionError: unknown;
			let falQueue: { statusUrl: string; responseUrl: string } | undefined;
			for (let attempt = 0; attempt <= VIDEO_MAX_SUBMIT_RETRIES; attempt++) {
				try {
					falQueue = await submitFalJob(credentials, { ...params, model }, signal);
					submissionError = undefined;
					break;
				} catch (error) {
					submissionError = error;
					// Transient 503/429 (queue saturated / throttled) backs off and
					// retries; anything else rethrows immediately.
					await retryTransientSubmit(attempt, error as Error, signal);
				}
			}
			if (!falQueue || submissionError) {
				throw new Error(
					`Video job submission failed after ${VIDEO_MAX_SUBMIT_RETRIES + 1} tries: ${submissionErrorDetail(submissionError)}`,
				);
			}
			const { statusUrl, responseUrl } = falQueue;
			try {
				let transientErrors = 0;
				for (;;) {
					if (Date.now() - startedAt > VIDEO_MAX_WAIT_MS) {
						throw new Error(
							`Video render exceeded ${Math.round(VIDEO_MAX_WAIT_MS / 60_000)} minutes — the queue may be congested. Try again or pick a different model.`,
						);
					}
					await untilAborted(signal, sleep(VIDEO_POLL_INTERVAL_MS));
					const status = await pollFalStatus(credentials.apiKey, statusUrl, signal);
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
					if (status.note !== jobNote) {
						jobNote = status.note;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Video rendering… ${Math.round((Date.now() - startedAt) / 1000)}s elapsed — ${status.note ?? status.error ?? "waiting"}`,
								},
							],
							details: { provider: credentials.provider, model, videoCount: 0, videoPaths: [], videoUrls: [] },
						});
					}
				}
				const videoUrl = await fetchFalVideoUrl(credentials.apiKey, responseUrl, signal);
				const bytes = await downloadVideo(videoUrl, signal);
				const videoPath = await saveVideoToTemp(bytes);
				const elapsedSeconds = (Date.now() - startedAt) / 1000;
				return {
					content: [
						{ type: "text", text: buildVideoSummary(credentials.provider, model, [videoPath], elapsedSeconds) },
					],
					details: {
						provider: credentials.provider,
						model,
						videoCount: 1,
						videoPaths: [videoPath],
						videoUrls: [videoUrl],
						resolution: params.resolution,
						durationSeconds: params.duration,
					},
				};
			} catch (error) {
				if (signal?.aborted) {
					cancelFalJob(credentials.apiKey, statusUrl);
				}
				throw error;
			}
		});
	},
};

interface VideoCandidate {
	/** Human-readable label shown in the interactive `ask` picker. */
	label: string;
	provider: VideoProvider;
	/** Provider-specific model id used for generation. */
	modelId: string;
}

/**
 * Enumerate all currently available video-generation options (provider +
 * model) by reusing the same credential resolution as auto-detection. Returns
 * them in the same priority order as `findVideoCredentials` so the first
 * entry is the default. Used to build the interactive `ask` picker options and
 * the "Available video models" list in the tool description.
 */
export async function enumerateVideoCandidates(
	modelRegistry: ModelRegistry | undefined,
	sessionId?: string,
): Promise<VideoCandidate[]> {
	const candidates: VideoCandidate[] = [];
	const pushUnique = (provider: VideoProvider, modelId: string): void => {
		if (candidates.some(c => c.provider === provider && c.modelId === modelId)) return;
		candidates.push({ label: `${provider} — ${modelId}`, provider, modelId });
	};

	if (modelRegistry) {
		const agnesModel = modelRegistry
			.getAll()
			.find(m => typeof m.baseUrl === "string" && m.baseUrl.includes(AGNES_BASE_URL_MARKER));
		if (agnesModel) {
			const apiKey = await modelRegistry.getApiKey(agnesModel, sessionId);
			if (isAuthenticated(apiKey) && typeof apiKey === "string") {
				for (const model of ["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]) {
					pushUnique("agnes", model);
				}
			}
		}
	}

	if (findFalKey()) {
		pushUnique("fal", DEFAULT_FAL_VIDEO_MODEL);
	}

	return candidates;
}

/**
 * Build the video generation tool list. Returns an empty array when neither
 * the Agnes custom provider (free video models) nor FAL_KEY is available so
 * the tool is simply not offered. When candidates exist, the tool description
 * advertises them so the model can present them via the interactive `ask`
 * picker, mirroring `buildImageGenToolWithCandidates`.
 */
export async function buildVideoToolWithCandidates(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<Array<CustomTool<typeof videoGenSchema, VideoGenToolDetails>>> {
	const credentials = await findVideoCredentials(modelRegistry, "auto", sessionId);
	if (!credentials) return [];

	const candidates = await enumerateVideoCandidates(modelRegistry, sessionId);
	const baseDescription = videoGenTool.description;
	let description = baseDescription;
	if (candidates.length > 0) {
		const list = candidates.map(c => `- ${c.label}`).join("\n");
		description = `${baseDescription}\n\n<available-models>\nAvailable video models:\n${list}\n</available-models>`;
	}
	return [{ ...videoGenTool, description }];
}

export async function getVideoGenTools(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<Array<CustomTool<typeof videoGenSchema, VideoGenToolDetails>>> {
	return buildVideoToolWithCandidates(modelRegistry, sessionId);
}
