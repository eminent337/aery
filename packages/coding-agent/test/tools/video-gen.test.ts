import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { CustomToolContext } from "@aryee337/aery/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@aryee337/aery/session/session-manager";
import { getVideoGenTools, videoGenTool } from "@aryee337/aery/tools/video-gen";

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

function makeContext(): CustomToolContext {
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as CustomToolContext;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("generate_video", () => {
	it("is not offered without FAL_KEY", async () => {
		delete Bun.env.FAL_KEY;
		expect(await getVideoGenTools()).toEqual([]);
	});

	it("is offered when FAL_KEY is set", async () => {
		Bun.env.FAL_KEY = "test-key:test-secret";
		expect(await getVideoGenTools()).toHaveLength(1);
	});

	it("submits, polls, fetches the result, and downloads the MP4", async () => {
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
				// Full queue lifecycle: queued -> rendering -> done.
				polls += 1;
				if (polls === 1) {
					return jsonResponse({ status: "IN_QUEUE", queue_position: 3 });
				}
				if (polls === 2) {
					return jsonResponse({ status: "IN_PROGRESS" });
				}
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
			"call-video",
			{ subject: "a panda", action: "eating a banana", duration: 5, aspect_ratio: "16:9" },
			undefined,
			makeContext(),
		);
		generatedVideoPaths.push(...(result.details?.videoPaths ?? []));

		const submit = calls.find(c => c.method === "POST");
		if (!submit) throw new Error("submit call missing");
		expect(submit.auth).toBe("Key test-key:test-secret");
		expect(submit.body).toMatchObject({
			prompt: "a panda, eating a banana.",
			duration: 5,
			aspect_ratio: "16:9",
		});
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(result.details?.provider).toBe("fal");
		expect(result.details?.model).toBe("fal-ai/wan-t2v");
		expect(result.details?.videoCount).toBe(1);
		expect(result.details?.videoUrls[0]).toBe("https://v3.fal.media/files/fake/out.mp4");
		const savedPath = result.details?.videoPaths[0];
		if (!savedPath) throw new Error("Expected saved video path");
		expect(await Bun.file(savedPath).bytes()).toEqual(videoBytes);
	}, 60_000);

	it("emits progress updates while polling", async () => {
		Bun.env.FAL_KEY = "test-key:test-secret";
		let polls = 0;
		let downloaded = false;
		const updates: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			if (method === "POST") {
				return jsonResponse({
					request_id: "req-prog",
					status_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-prog/status",
					response_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-prog",
				});
			}
			if (url.endsWith("/status")) {
				polls += 1;
				if (polls < 3) return jsonResponse({ status: "IN_QUEUE", queue_position: polls });
				return jsonResponse({
					status: "OK",
					response_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-prog",
				});
			}
			if (url.endsWith("/requests/req-prog")) {
				return jsonResponse({ video: { url: "https://v3.fal.media/files/fake/prog.mp4" } });
			}
			if (url.startsWith("https://v3.fal.media/")) {
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
			"call-video-prog",
			{ subject: "a panda" },
			update => {
				for (const part of update.content) {
					if (part.type === "text") updates.push(part.text);
				}
			},
			makeContext(),
		);
		generatedVideoPaths.push(...(result.details?.videoPaths ?? []));

		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]).toContain("Video rendering");
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(downloaded).toBe(true);
	}, 60_000);

	it("surfaces render failures as tool errors", async () => {
		Bun.env.FAL_KEY = "test-key:test-secret";
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			if (method === "POST") {
				return jsonResponse({
					request_id: "req-err",
					status_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-err/status",
					response_url: "https://queue.fal.run/fal-ai/wan-t2v/requests/req-err",
				});
			}
			if (url.endsWith("/status")) {
				return jsonResponse({ status: "ERROR", detail: "safety check failed" });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		let thrown: unknown;
		try {
			await videoGenTool.execute("call-video-err", { subject: "a panda" }, undefined, makeContext());
		} catch (error) {
			thrown = error;
		}
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("safety check failed");
	}, 60_000);

	it("reports submission errors with provider detail", async () => {
		Bun.env.FAL_KEY = "test-key:test-secret";
		const fetchMock: typeof fetch = (async () => {
			return jsonResponse({ detail: "Cannot access application" }, 401);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		let thrown: unknown;
		try {
			await videoGenTool.execute("call-video-401", { subject: "a panda" }, undefined, makeContext());
		} catch (error) {
			thrown = error;
		}
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("401");
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("Cannot access application");
	}, 60_000);
});
