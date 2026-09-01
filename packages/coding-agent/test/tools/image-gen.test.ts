import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { ModelRegistry } from "@aryee337/aery/config/model-registry";
import type { CustomToolContext } from "@aryee337/aery/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@aryee337/aery/session/session-manager";
import { imageGenTool, setPreferredImageProvider } from "@aryee337/aery/tools/image-gen";
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

	it("routes custom-provider (Agnes) image generation to /images/generations", async () => {
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const captured: { authorization: string | null } = { authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			captured.authorization = new Headers(init?.headers).get("authorization");
			return new Response(
				JSON.stringify({
					data: [{ b64_json: Buffer.from("fake-agnes-image").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
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
			response_format: "b64_json",
		});
		expect(result.details?.provider).toBe("custom");
		expect(result.details?.model).toBe("agnes-image-2.5-flash");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-agnes-image"));
	});

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
});
