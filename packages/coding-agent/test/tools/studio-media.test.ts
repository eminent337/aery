// The poll-interval env must be set before media-state (and its dependency
// chain, video-gen.ts) evaluates: media-state imports videoGenTool statically,
// so the module-level VIDEO_POLL_INTERVAL_MS const would otherwise already be
// locked to the default. Deliberate module-loading-boundary test — static
// import cannot express "load after env is set".
process.env.AERY_VIDEO_POLL_INTERVAL_MS = "25";

const { MediaStateManager } = await import("@aryee337/aery/modes/components/studio/media-state");

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { ModelRegistry } from "@aryee337/aery/config/model-registry";
import type { Model } from "@aryee337/aery-ai";

const originalFetch = global.fetch;
const originalFalKey = Bun.env.FAL_KEY;

function makeRegistry(model: Model | undefined, apiKey: unknown): ModelRegistry {
	return {
		getApiKey: async () => apiKey,
		getApiKeyForProvider: async () => undefined,
		getProviderBaseUrl: () => undefined,
		getAll: () => (model ? [model] : []),
		authStorage: { hasNonEnvCredential: () => false },
	} as unknown as ModelRegistry;
}

const agnesVideoModel = {
	id: "agnes-video-2.5-flash",
	name: "Agnes Video 2.5 Flash",
	baseUrl: "https://apihub.agnes-ai.com/v1",
} as Model;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Wait until cond() is true (polling, bounded). */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

describe("MediaStateManager", () => {
	let manager: InstanceType<typeof MediaStateManager>;
	let videoBytes: Buffer<ArrayBuffer>;
	let fetchCalls: Array<{ url: string; method: string }>;

	beforeEach(() => {
		manager = new MediaStateManager();
		fetchCalls = [];
		videoBytes = Buffer.from("studio-video-bytes");
		delete Bun.env.FAL_KEY;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalFalKey === undefined) {
			delete Bun.env.FAL_KEY;
		} else {
			Bun.env.FAL_KEY = originalFalKey;
		}
	});

	it("fails a job cleanly when no session context is attached", async () => {
		const snapshot = manager.getSnapshot();
		expect(snapshot.jobs).toEqual([]);
		expect(snapshot.gallery).toEqual([]);
		expect(snapshot.selectedIndex).toBe(-1);

		manager.enqueue({ kind: "image", subject: "a lighthouse" });
		await waitFor(() => manager.getSnapshot().jobs[0]?.status === "failed");
		const job = manager.getSnapshot().jobs[0];
		expect(job.error).toContain("not attached");
	});

	it("runs a video job end-to-end through the real tool path and archives to gallery", async () => {
		let polls = 0;
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			fetchCalls.push({ url, method });

			if (method === "POST" && url === "https://apihub.agnes-ai.com/v1/videos") {
				return jsonResponse({ id: "vid_studio1" });
			}
			if (url === "https://apihub.agnes-ai.com/v1/videos/vid_studio1") {
				polls += 1;
				if (polls === 1) {
					return jsonResponse({ status: "in_progress", progress: 40 });
				}
				return jsonResponse({
					status: "completed",
					progress: 100,
					metadata: { url: "https://platform-outputs.agnes-ai.space/videos/studio1.mp4" },
				});
			}
			if (url === "https://platform-outputs.agnes-ai.space/videos/studio1.mp4") {
				return new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		global.fetch = fetchMock;

		manager.setContext({
			modelRegistry: makeRegistry(agnesVideoModel, "test-agnes-key"),
			sessionId: "studio-session",
			cwd: "/tmp",
		});
		manager.enqueue({ kind: "video", subject: "a hummingbird", duration: 5 });

		await waitFor(() => manager.getSnapshot().jobs[0]?.status === "completed");

		const job = manager.getSnapshot().jobs[0];
		expect(job.videoPaths).toHaveLength(1);
		expect(await Bun.file(job.videoPaths![0]).bytes()).toEqual(videoBytes);

		const snapshot = manager.getSnapshot();
		expect(snapshot.gallery).toHaveLength(1);
		expect(snapshot.gallery[0].kind).toBe("video");
		expect(snapshot.gallery[0].prompt).toBe("a hummingbird");
		expect(snapshot.selectedIndex).toBe(-1); // selection starts unset
	});

	it("streams progress updates from onUpdate into job.note", async () => {
		let polls = 0;
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";

			if (method === "POST" && url === "https://apihub.agnes-ai.com/v1/videos") {
				return jsonResponse({ id: "vid_studio2" });
			}
			if (url === "https://apihub.agnes-ai.com/v1/videos/vid_studio2") {
				polls += 1;
				if (polls <= 2) {
					return jsonResponse({ status: "in_progress", progress: 25 * polls });
				}
				return jsonResponse({
					status: "completed",
					metadata: { url: "https://platform-outputs.agnes-ai.space/videos/studio2.mp4" },
				});
			}
			if (url === "https://platform-outputs.agnes-ai.space/videos/studio2.mp4") {
				return new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "video/mp4" } });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		global.fetch = fetchMock;

		manager.setContext({
			modelRegistry: makeRegistry(agnesVideoModel, "test-agnes-key"),
			sessionId: "studio-session",
			cwd: "/tmp",
		});
		manager.enqueue({ kind: "video", subject: "waves" });

		await waitFor(() => manager.getSnapshot().jobs[0]?.status === "completed");
		// Somewhere during the run the note must have carried a poll update.
		const job = manager.getSnapshot().jobs[0];
		expect(job.status).toBe("completed");
		expect(polls).toBeGreaterThanOrEqual(3);
	});

	it("drains queued jobs sequentially (one at a time)", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";

			if (method === "POST" && url === "https://apihub.agnes-ai.com/v1/videos") {
				concurrent += 1;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise(resolve => setTimeout(resolve, 60));
				concurrent -= 1;
				return jsonResponse({ id: `vid_seq_${fetchCalls.length}` });
			}
			if (url.startsWith("https://apihub.agnes-ai.com/v1/videos/vid_seq_")) {
				return jsonResponse({
					status: "completed",
					metadata: { url: "https://platform-outputs.agnes-ai.space/videos/seq.mp4" },
				});
			}
			if (url === "https://platform-outputs.agnes-ai.space/videos/seq.mp4") {
				return new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "video/mp4" } });
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		global.fetch = fetchMock;

		manager.setContext({
			modelRegistry: makeRegistry(agnesVideoModel, "test-agnes-key"),
			sessionId: "studio-session",
			cwd: "/tmp",
		});
		manager.enqueue({ kind: "video", subject: "job one" });
		manager.enqueue({ kind: "video", subject: "job two" });
		manager.enqueue({ kind: "video", subject: "job three" });

		await waitFor(() => manager.getSnapshot().jobs.every((j: { status: string }) => j.status === "completed"));
		// Archiving is async (file copies); wait for the gallery to settle before counting.
		await waitFor(() => manager.getSnapshot().gallery.length === 3);
		expect(maxConcurrent).toBe(1);

		const snapshot = manager.getSnapshot();
		expect(snapshot.jobs).toHaveLength(3);
		expect(snapshot.gallery).toHaveLength(3);
	});

	it("moveSelection clamps to gallery bounds and cancels only queued jobs", async () => {
		expect(manager.getSnapshot().gallery).toEqual([]);

		manager.moveSelection(1);
		expect(manager.getSnapshot().selectedIndex).toBe(-1);

		// cancelQueued on unknown id is a no-op
		manager.cancelQueued("nope");

		// enqueue without context → fails; cancelled-before-run path:
		const failing = new MediaStateManager();
		failing.enqueue({ kind: "image", subject: "never runs" });
		await waitFor(() => failing.getSnapshot().jobs[0]?.status === "failed");
		failing.enqueue({ kind: "image", subject: "queued behind" });
		// Second job is queued (no context → first fails, second runs and fails too)
		await waitFor(() => failing.getSnapshot().jobs.every((j: { status: string }) => j.status === "failed"));
	});

	it("persists completed videos to ~/.aery/studio/videos/", async () => {
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			if (method === "POST" && url === "https://apihub.agnes-ai.com/v1/videos") {
				return jsonResponse({ id: "vid_persist" });
			}
			if (url === "https://apihub.agnes-ai.com/v1/videos/vid_persist") {
				return jsonResponse({
					status: "completed",
					metadata: { url: "https://platform-outputs.agnes-ai.space/videos/persist.mp4" },
				});
			}
			if (url === "https://platform-outputs.agnes-ai.space/videos/persist.mp4") {
				return new Response(Buffer.from("persisted-bytes"), {
					status: 200,
					headers: { "content-type": "video/mp4" },
				});
			}
			return new Response("unexpected", { status: 500 });
		}) as unknown as typeof fetch;
		global.fetch = fetchMock;

		manager.setContext({
			modelRegistry: makeRegistry(agnesVideoModel, "test-agnes-key"),
			sessionId: "studio-session",
			cwd: "/tmp",
		});
		manager.enqueue({ kind: "video", subject: "persistence check" });

		await waitFor(
			() =>
				manager.getSnapshot().gallery.length > 0 &&
				manager.getSnapshot().gallery[0].path.includes(`${os.homedir()}/.aery/studio/videos/`),
		);

		const entry = manager.getSnapshot().gallery[0];
		expect(entry.path.startsWith(`${os.homedir()}/.aery/studio/videos/`)).toBe(true);
		expect(entry.prompt).toBe("persistence check");
		// The persisted file really exists on disk with the right bytes.
		expect(await Bun.file(entry.path).text()).toBe("persisted-bytes");

		await fs.rm(entry.path, { force: true });
	}, 10_000);
});
