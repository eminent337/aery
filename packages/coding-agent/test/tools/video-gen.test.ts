import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { ModelRegistry } from "@aryee337/aery/config/model-registry";
import type { CustomToolContext } from "@aryee337/aery/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@aryee337/aery/session/session-manager";
import {
	buildVideoToolWithCandidates,
	enumerateVideoCandidates,
	getVideoGenTools,
	videoGenTool,
} from "@aryee337/aery/tools/video-gen";
import type { Model } from "@aryee337/aery-ai";

const originalFetch = global.fetch;
const originalFalKey = Bun.env.FAL_KEY;
const generatedVideoPaths: string[] = [];

afterEach(async () => {
	await Promise.all(generatedVideoPaths.splice(0).map(videoPath => fs.rm(videoPath, { force: true })));
	global.fetch = originalFetch;
	if (originalFalKey === undefined) {
		delete Bun.env.FAL_KEY;
	} else {
		Bun.env.FAL_KEY = originalFalKey;
	}
});

function makeRegistry(model: Model | undefined, apiKey: unknown): ModelRegistry {
	return {
		getApiKey: async () => apiKey,
		getApiKeyForProvider: async () => undefined,
		getProviderBaseUrl: () => undefined,
		getAll: () => (model ? [model] : []),
		authStorage: { hasNonEnvCredential: () => false },
	} as unknown as ModelRegistry;
}

const agnesModel = {
	api: "openai-completions",
	provider: "custom-api-apihub-agnes-ai-com-v1",
	id: "agnes-2.5-pro",
	name: "Agnes 2.5 Pro",
	baseUrl: "https://apihub.agnes-ai.com/v1",
} as Model;

function makeContext(registry?: ModelRegistry): CustomToolContext {
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: registry,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as CustomToolContext;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("generate_video", () => {
	it("is not offered without any video credentials", async () => {
		delete Bun.env.FAL_KEY;
		expect(await getVideoGenTools(makeRegistry(undefined, undefined))).toEqual([]);
		expect(await getVideoGenTools(undefined)).toEqual([]);
	});

	it("is offered via Agnes when the custom provider is registered", async () => {
		delete Bun.env.FAL_KEY;
		expect(await getVideoGenTools(makeRegistry(agnesModel, "test-agnes-key"))).toHaveLength(1);
	});

	it("is offered via fal when FAL_KEY is set", async () => {
		delete Bun.env.FAL_KEY;
		Bun.env.FAL_KEY = "test-key:test-secret";
		expect(await getVideoGenTools(makeRegistry(undefined, undefined))).toHaveLength(1);
	});

	it("prefers Agnes (free) over fal in auto mode", async () => {
		Bun.env.FAL_KEY = "test-key:test-secret";
		const calls: Array<{ url: string; method: string; auth: string | null; body?: unknown }> = [];
		const videoBytes = Buffer.from("fake-agnes-mp4");
		let polls = 0;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			const auth = new Headers(init?.headers).get("authorization");
			calls.push({ url, method, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined });

			if (method === "POST" && url === "https://apihub.agnes-ai.com/v1/videos") {
				return jsonResponse({ id: "task_agg1", object: "video", status: "in_progress", progress: 0 });
			}
			if (url === "https://apihub.agnes-ai.com/v1/videos/task_agg1") {
				polls += 1;
				if (polls === 1) return jsonResponse({ status: "in_progress", progress: 40 });
				return jsonResponse({
					status: "completed",
					progress: 100,
					metadata: { url: "https://platform-outputs.agnes-ai.space/videos/out.mp4" },
				});
			}
			if (url.startsWith("https://platform-outputs.agnes-ai.space/")) {
				return new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const result = await videoGenTool.execute(
			"call-agnes",
			{ subject: "a panda", action: "eating a banana", duration: 5 },
			undefined,
			makeContext(makeRegistry(agnesModel, "test-agnes-key")),
		);
		generatedVideoPaths.push(...(result.details?.videoPaths ?? []));

		const submit = calls.find(c => c.method === "POST");
		if (!submit) throw new Error("submit call missing");
		expect(submit.auth).toBe("Bearer test-agnes-key");
		expect(submit.body).toMatchObject({
			model: "agnes-video-2.5-flash",
			prompt: "a panda, eating a banana.",
			mode: "text",
			seconds: "5",
		});
		expect(polls).toBeGreaterThanOrEqual(2);
		expect(result.details?.provider).toBe("agnes");
		expect(result.details?.model).toBe("agnes-video-2.5-flash");
		expect(result.details?.videoCount).toBe(1);
		expect(result.details?.videoUrls[0]).toBe("https://platform-outputs.agnes-ai.space/videos/out.mp4");
		const savedPath = result.details?.videoPaths[0];
		if (!savedPath) throw new Error("Expected saved video path");
		expect(await Bun.file(savedPath).bytes()).toEqual(videoBytes);
	}, 60_000);

	it("falls back to fal when FAL_KEY is set and no Agnes provider exists", async () => {
		Bun.env.FAL_KEY = "test-key:test-secret";
		const calls: Array<{ url: string; method: string; auth: string | null; body?: unknown }> = [];
		let polls = 0;
		const videoBytes = Buffer.from("fake-mp4-bytes");

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			const auth = new Headers(init?.headers).get("authorization");
			calls.push({ url, method, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined });

			if (method === "POST" && url.startsWith("https://queue.fal.run/fal-ai/wan-t2v")) {
				return jsonResponse({
					request_id: "req-123",
					status_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-123/status",
					response_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-123",
				});
			}
			if (url.endsWith("/status")) {
				polls += 1;
				if (polls === 1) return jsonResponse({ status: "IN_QUEUE", queue_position: 3 });
				if (polls === 2) return jsonResponse({ status: "IN_PROGRESS" });
				return jsonResponse({
					status: "OK",
					response_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-123",
				});
			}
			if (url.endsWith("/requests/req-123")) {
				return jsonResponse({ video: { url: "https://v3.fal.media/files/fake/out.mp4" } });
			}
			if (url.startsWith("https://v3.fal.media/")) {
				return new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const result = await videoGenTool.execute(
			"call-fal",
			{ subject: "a panda", action: "eating a banana", duration: 5 },
			undefined,
			makeContext(makeRegistry(undefined, undefined)),
		);
		generatedVideoPaths.push(...(result.details?.videoPaths ?? []));

		const submit = calls.find(c => c.method === "POST");
		if (!submit) throw new Error("submit call missing");
		expect(submit.auth).toBe("Key test-key:test-secret");
		expect(submit.body).toMatchObject({ prompt: "a panda, eating a banana.", duration: 5 });
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(result.details?.provider).toBe("fal");
		expect(result.details?.model).toBe("fal-ai/wan-t2v");
		expect(result.details?.videoCount).toBe(1);
	}, 60_000);

	it("emits progress updates while polling", async () => {
		delete Bun.env.FAL_KEY;
		let polls = 0;
		let downloaded = false;
		const updates: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			if (method === "POST" && url.endsWith("/videos")) {
				return jsonResponse({ id: "task_prog", status: "in_progress", progress: 0 });
			}
			if (url.endsWith("/videos/task_prog")) {
				polls += 1;
				if (polls < 3) return jsonResponse({ status: "in_progress", progress: polls * 30 });
				return jsonResponse({
					status: "completed",
					progress: 100,
					metadata: { url: "https://platform-outputs.agnes-ai.space/videos/prog.mp4" },
				});
			}
			if (url.startsWith("https://platform-outputs.agnes-ai.space/")) {
				downloaded = true;
				return new Response(Buffer.from("prog-bytes"), {
					status: 200,
					headers: { "content-type": "video/mp4" },
				});
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const result = await videoGenTool.execute(
			"call-prog",
			{ subject: "a panda" },
			update => {
				for (const part of update.content) {
					if (part.type === "text") updates.push(part.text);
				}
			},
			makeContext(makeRegistry(agnesModel, "test-agnes-key")),
		);
		generatedVideoPaths.push(...(result.details?.videoPaths ?? []));

		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]).toContain("Video rendering");
		expect(downloaded).toBe(true);
	}, 60_000);

	it("surfaces render failures as tool errors", async () => {
		delete Bun.env.FAL_KEY;
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			if (method === "POST" && url.endsWith("/videos")) {
				return jsonResponse({ id: "task_err", status: "in_progress", progress: 0 });
			}
			if (url.endsWith("/videos/task_err")) {
				return jsonResponse({ status: "failed", error: { message: "safety check failed" } });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		let thrown: unknown;
		try {
			await videoGenTool.execute(
				"call-err",
				{ subject: "a panda" },
				undefined,
				makeContext(makeRegistry(agnesModel, "test-agnes-key")),
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("safety check failed");
	}, 60_000);

	it("reports submission errors with provider detail", async () => {
		delete Bun.env.FAL_KEY;
		const fetchMock: typeof fetch = (async () => {
			return jsonResponse(
				{ error: { message: "video generation rate limit exceeded: allows 2 requests per 1 minute(s)" } },
				429,
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		let thrown: unknown;
		try {
			await videoGenTool.execute(
				"call-429",
				{ subject: "a panda" },
				undefined,
				makeContext(makeRegistry(agnesModel, "test-agnes-key")),
			);
		} catch (error) {
			thrown = error;
		}
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).toContain("429");
		expect(message).toContain("rate limit");
	}, 60_000);

	it("enumerates candidates: Agnes models when Agnes key, fal when FAL_KEY", async () => {
		delete Bun.env.FAL_KEY;

		const agnesRegistry = makeRegistry(agnesModel, "test-agnes-key");
		const agnesCandidates = await enumerateVideoCandidates(agnesRegistry);
		expect(agnesCandidates.map(c => c.label)).toEqual([
			"agnes — agnes-video-2.5",
			"agnes — agnes-video-2.5-flash",
			"agnes — agnes-video-v2.0",
		]);

		delete Bun.env.FAL_KEY;
		Bun.env.FAL_KEY = "test-key:test-secret";
		const falCandidates = await enumerateVideoCandidates(undefined);
		expect(falCandidates.map(c => `${c.provider} — ${c.modelId}`)).toEqual(["fal — fal-ai/wan-t2v"]);

		delete Bun.env.FAL_KEY;
		expect(await enumerateVideoCandidates(undefined)).toEqual([]);
	});

	it("builds tool with <available-models> list mirroring image", async () => {
		delete Bun.env.FAL_KEY;
		const tools = await buildVideoToolWithCandidates(makeRegistry(agnesModel, "test-agnes-key"));
		expect(tools).toHaveLength(1);
		expect(tools[0].description).toContain("<available-models>");
		expect(tools[0].description).toContain("Available video models:");
		expect(tools[0].description).toContain("- agnes — agnes-video-2.5");
		expect(tools[0].description).toContain("- agnes — agnes-video-2.5-flash");
		expect(tools[0].description).toContain("- agnes — agnes-video-v2.0");
	});
});
