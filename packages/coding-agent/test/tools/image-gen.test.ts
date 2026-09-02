import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { ModelRegistry } from "@aryee337/aery/config/model-registry";
import type { CustomToolContext } from "@aryee337/aery/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@aryee337/aery/session/session-manager";
import { enumerateImageCandidates, imageGenTool, setPreferredImageProvider } from "@aryee337/aery/tools/image-gen";
import type { Model } from "@aryee337/aery-ai";

const originalFetch = global.fetch;
const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const generatedImagePaths: string[] = [];

afterEach(async () => {
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => fs.rm(imagePath, { force: true })));
	global.fetch = originalFetch;
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	setPreferredImageProvider("auto");
});

function makeCustomAgnesContext(): CustomToolContext {
	const textModel = {
		api: "openai-completions",
		provider: "custom-api-apihub-agnes-ai-com-v1",
		id: "agnes-2.5-pro",
		name: "Agnes 2.5 Pro",
		baseUrl: "https://apihub.agnes-ai.com/v1",
	} as Model;
	const imageOnlyModel = {
		api: "openai-completions",
		provider: "custom-api-apihub-agnes-ai-com-v1",
		id: "agnes-image-2.5-flash",
		name: "Agnes Image 2.5 Flash",
		baseUrl: "https://apihub.agnes-ai.com/v1",
		imageOnly: true,
	} as unknown as Model;
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => "test-agnes-key",
			getApiKeyForProvider: async () => undefined,
			getProviderBaseUrl: () => undefined,
			getAll: () => [textModel, imageOnlyModel],
			authStorage: {
				hasNonEnvCredential: () => false,
			},
		} as unknown as ModelRegistry,
		model: textModel,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as CustomToolContext;
}

describe("imageGenTool", () => {
	it("e2e writes OpenAI Responses image_generation WebP output to a temp file", async () => {
		let requestUrl: string | undefined;
		let requestBody: unknown;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							revised_prompt: "A crisp tabby cat portrait.",
							status: "completed",
						},
					],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat", aspect_ratio: "16:9" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", size: "1536x1024", action: "generate" }],
			tool_choice: { type: "image_generation" },
			store: false,
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
		expect(result.details?.revisedPrompt).toBe("A crisp tabby cat portrait.");
		expect(result.details?.imagePaths).toHaveLength(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(savedPath.endsWith(".webp")).toBe(true);
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-webp"));
	});

	it("routes xAI image generation with xAI-only aspect ratios", async () => {
		setPreferredImageProvider("xai");
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const captured: { authorization: string | null; userAgent: string | null } = {
			authorization: null,
			userAgent: null,
		};

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const headers = new Headers(init?.headers);
			captured.authorization = headers.get("authorization");
			captured.userAgent = headers.get("user-agent");
			return new Response(
				JSON.stringify({
					data: [{ b64_json: Buffer.from("fake-xai-image").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
				},
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-xai", { subject: "a cat", aspect_ratio: "3:2" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.x.ai/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-xai-token");
		expect(captured.userAgent).toBe("aery/xai");
		expect(requestBody).toMatchObject({
			model: "grok-imagine-image",
			prompt: "a cat.",
			aspect_ratio: "3:2",
			resolution: "1k",
			n: 1,
			response_format: "b64_json",
		});
		expect(result.details?.provider).toBe("xai");
		expect(result.details?.model).toBe("grok-imagine-image");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-xai-image"));
	});

	it("routes antigravity image generation to the daily endpoint with the real image model", async () => {
		setPreferredImageProvider("antigravity");
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const chunk = {
				response: {
					candidates: [
						{
							content: {
								role: "model",
								parts: [
									{
										inlineData: {
											mimeType: "image/jpeg",
											data: Buffer.from("fake-ag-image").toString("base64"),
										},
									},
								],
							},
						},
					],
				},
			};
			const sse = `data: ${JSON.stringify(chunk)}\r\n\r\n`;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(sse));
					controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "unused",
				getApiKeyForProvider: async (provider: string) =>
					provider === "google-antigravity"
						? JSON.stringify({ token: "test-ag-token", projectId: "test-project" })
						: undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "google-antigravity",
				},
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-ag", { subject: "a cat", aspect_ratio: "1:1" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe(
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		);
		expect(requestBody?.model).toBe("gemini-3.1-flash-image");
		expect(requestBody?.project).toBe("test-project");
		const genConfig = (requestBody?.request as Record<string, unknown> | undefined)?.generationConfig as
			| { imageConfig?: { aspectRatio?: string; imageSize?: string } }
			| undefined;
		expect(genConfig?.imageConfig?.aspectRatio).toBe("1:1");
		expect(genConfig?.imageConfig?.imageSize).toBeUndefined();
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3.1-flash-image");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/jpeg");
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-ag-image"));
	}, 60_000);

	it("routes custom-provider (Agnes) image generation to /images/generations", async () => {
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		let downloadedUrl: string | undefined;
		const captured: { authorization: string | null } = { authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (typeof init?.body === "string") {
				requestUrl = input.toString();
				requestBody = JSON.parse(init.body) as Record<string, unknown>;
				captured.authorization = new Headers(init?.headers).get("authorization");
				return new Response(
					JSON.stringify({
						data: [{ url: "https://mock-cdn.example/out.png", b64_json: "" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			downloadedUrl = input.toString();
			return new Response(Buffer.from("fake-agnes-image"), {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-completions",
			provider: "custom-api-apihub-agnes-ai-com-v1",
			id: "agnes-image-2.5-flash",
			name: "Agnes Image 2.5 Flash",
			baseUrl: "https://apihub.agnes-ai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-agnes-key",
				getApiKeyForProvider: async () => undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: () => false,
				},
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-agnes", { subject: "a panda" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://apihub.agnes-ai.com/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-agnes-key");
		expect(requestBody).toMatchObject({
			model: "agnes-image-2.5-flash",
			prompt: "a panda.",
			n: 1,
			size: "1024x1024",
			response_format: "url",
		});
		expect(downloadedUrl).toBe("https://mock-cdn.example/out.png");
		expect(result.details?.provider).toBe("custom");
		expect(result.details?.model).toBe("agnes-image-2.5-flash");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-agnes-image"));
	});

	it("overrides a same-provider candidate default when an explicit model id is requested", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("override-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		// The registry's default custom image model is 2.0…
		const model = {
			api: "openai-completions",
			provider: "custom-api-apihub-agnes-ai-com-v1",
			id: "agnes-image-2.0-flash",
			name: "Agnes Image 2.0 Flash",
			baseUrl: "https://apihub.agnes-ai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-agnes-key",
				getApiKeyForProvider: async () => undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: () => false,
				},
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		// …but the caller explicitly asks for 2.1: the request must carry 2.1,
		// not the provider's default.
		const result = await imageGenTool.execute(
			"call-override",
			{ subject: "a panda", provider: "custom", model: "agnes-image-2.1-flash" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestBody?.model).toBe("agnes-image-2.1-flash");
		expect(result.details?.model).toBe("agnes-image-2.1-flash");
		expect(result.details?.provider).toBe("custom");
	}, 60_000);

	it("falls back to a registered imageOnly custom model when the active model is text-only", async () => {
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const captured: { authorization: string | null } = { authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			captured.authorization = new Headers(init?.headers).get("authorization");
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("fallback-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		// Active model is a plain text model on the Agnes custom provider.
		const textModel = {
			api: "openai-completions",
			provider: "custom-api-apihub-agnes-ai-com-v1",
			id: "agnes-2.5-pro",
			name: "Agnes 2.5 Pro",
			baseUrl: "https://apihub.agnes-ai.com/v1",
		} as Model;
		// The image-only model is registered but hidden from chat selection.
		const imageOnlyModel = {
			api: "openai-completions",
			provider: "custom-api-apihub-agnes-ai-com-v1",
			id: "agnes-image-2.5-flash",
			name: "Agnes Image 2.5 Flash",
			baseUrl: "https://apihub.agnes-ai.com/v1",
			imageOnly: true,
		} as unknown as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-agnes-key",
				getApiKeyForProvider: async () => undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [textModel, imageOnlyModel],
				authStorage: {
					hasNonEnvCredential: () => false,
				},
			} as unknown as ModelRegistry,
			model: textModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-fallback", { subject: "a panda" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://apihub.agnes-ai.com/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-agnes-key");
		expect(requestBody?.model).toBe("agnes-image-2.5-flash");
		expect(result.details?.provider).toBe("custom");
		expect(result.details?.model).toBe("agnes-image-2.5-flash");
		expect(result.details?.imageCount).toBe(1);
	});
	it("retries transient 503 queue-full responses on the custom provider", async () => {
		let callCount = 0;
		const fetchMock: typeof fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
			callCount++;
			if (callCount <= 2) {
				return new Response(
					JSON.stringify({ error: { message: "text image queue is full, please retry later" } }),
					{
						status: 503,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("retried-image").toString("base64") }] }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx = makeCustomAgnesContext();
		const result = await imageGenTool.execute("call-retry-503", { subject: "a dog" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(callCount).toBe(3);
		expect(result.details?.provider).toBe("custom");
		expect(result.details?.imageCount).toBe(1);
	}, 60_000);

	it("retries per-attempt timeouts and throws a friendly error after exhausting attempts", async () => {
		let callCount = 0;
		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			callCount++;
			const sig = init?.signal;
			const reason = sig?.reason ?? new DOMException("The operation was aborted.", "AbortError");
			return await new Promise<Response>((_, reject) => {
				if (sig?.aborted) {
					reject(reason);
				} else {
					sig?.addEventListener("abort", () => reject(reason), { once: true });
				}
			});
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const originalSignalTimeout = AbortSignal.timeout;
		(AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = (ms: number) => {
			void ms;
			const controller = new AbortController();
			controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
			return controller.signal;
		};
		try {
			const ctx = makeCustomAgnesContext();
			await expect(imageGenTool.execute("call-timeout", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(
				"timed out after 3 attempt(s)",
			);
		} finally {
			(AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = originalSignalTimeout;
		}
		expect(callCount).toBe(3);
	}, 60_000);

	it("propagates user cancellation without retrying the custom provider request", async () => {
		let callCount = 0;
		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			callCount++;
			const sig = init?.signal;
			return await new Promise<Response>((_, reject) => {
				const rejectNow = () => reject(sig?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
				if (sig?.aborted) {
					rejectNow();
				} else {
					sig?.addEventListener("abort", rejectNow, { once: true });
				}
			});
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx = makeCustomAgnesContext();
		const controller = new AbortController();
		const executePromise = imageGenTool.execute(
			"call-cancel",
			{ subject: "a cat" },
			undefined,
			ctx,
			controller.signal,
		);
		for (let i = 0; i < 100 && callCount === 0; i++) await Bun.sleep(10);
		expect(callCount).toBe(1);
		controller.abort();
		await expect(executePromise).rejects.toThrow("Aborted");
		expect(callCount).toBe(1);
	}, 60_000);
});

describe("pollinations provider", () => {
	it("generates via the GET endpoint with no credentials and saves the image", async () => {
		let requestUrl: string | undefined;
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(Buffer.from("fake-pollinations-jpeg"), {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			});
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async () => undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: { hasNonEnvCredential: () => false },
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-pollinations",
			{ subject: "a panda", aspect_ratio: "16:9", provider: "pollinations" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toContain("https://image.pollinations.ai/prompt/");
		expect(requestUrl).toContain("width=1024");
		expect(requestUrl).toContain("height=576");
		expect(requestUrl).toContain("model=flux");
		expect(result.details?.provider).toBe("pollinations");
		expect(result.details?.model).toBe("flux");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-pollinations-jpeg"));
	}, 60_000);

	it("is offered as a candidate even with no credentials at all", async () => {
		const registry = {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async () => undefined,
			getProviderBaseUrl: () => undefined,
			getAll: () => [],
			authStorage: { hasNonEnvCredential: () => false },
		} as unknown as ModelRegistry;

		const candidates = await enumerateImageCandidates(registry, undefined);
		expect(candidates.some(c => c.provider === "pollinations")).toBe(true);
	}, 60_000);
});

describe("enumerateImageCandidates", () => {
	it("lists every authenticated image-only custom model, not just the first", async () => {
		const mk = (id: string) =>
			({
				api: "openai-completions",
				provider: "custom-api-apihub-agnes-ai-com-v1",
				id,
				name: id,
				baseUrl: "https://apihub.agnes-ai.com/v1",
				imageOnly: true,
			}) as unknown as Model;
		const models = [mk("agnes-image-2.0-flash"), mk("agnes-image-2.1-flash"), mk("agnes-image-2.5-flash")];
		const registry = {
			getApiKey: async () => "test-agnes-key",
			getApiKeyForProvider: async () => undefined,
			getProviderBaseUrl: () => undefined,
			getAll: () => models,
			authStorage: { hasNonEnvCredential: () => false },
		} as unknown as ModelRegistry;

		const candidates = await enumerateImageCandidates(registry, undefined);
		const custom = candidates.filter(c => c.provider === "custom").map(c => c.modelId);

		expect(custom).toEqual(["agnes-image-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.5-flash"]);
	}, 60_000);

	it("still returns the first custom model as the auto-detected default", async () => {
		const mk = (id: string) =>
			({
				api: "openai-completions",
				provider: "custom-api-apihub-agnes-ai-com-v1",
				id,
				name: id,
				baseUrl: "https://apihub.agnes-ai.com/v1",
				imageOnly: true,
			}) as unknown as Model;
		const models = [mk("agnes-image-2.0-flash"), mk("agnes-image-2.5-flash")];
		const registry = {
			getApiKey: async () => "test-agnes-key",
			getApiKeyForProvider: async () => undefined,
			getProviderBaseUrl: () => undefined,
			getAll: () => models,
			authStorage: { hasNonEnvCredential: () => false },
		} as unknown as ModelRegistry;

		const candidates = await enumerateImageCandidates(registry, undefined);
		const firstCustom = candidates.find(c => c.provider === "custom");

		expect(firstCustom?.modelId).toBe("agnes-image-2.0-flash");
	}, 60_000);
});
