import { describe, expect, it } from "bun:test";
import { streamGoogle } from "../src/providers/google";
import { getOAuthProviders } from "../src/utils/oauth";
import {
	formatGoogleAiStudioApiKey,
	GOOGLE_AISTUDIO_CALLBACK_PATH,
	GOOGLE_AISTUDIO_CALLBACK_PORT,
	GOOGLE_AISTUDIO_SCOPES,
} from "../src/utils/oauth/google-aistudio";
import type { Context, Model } from "../src/types";

describe("Google AI Studio Web Auth & Provider", () => {
	it("registers google-aistudio in OAuth providers catalog", () => {
		const providers = getOAuthProviders();
		const aiStudioProvider = providers.find(p => p.id === "google-aistudio");
		expect(aiStudioProvider).toBeDefined();
		expect(aiStudioProvider?.name).toContain("Google AI Studio");
		expect(aiStudioProvider?.available).toBe(true);
	});

	it("exports expected callback port, path, and generative-language scopes", () => {
		expect(GOOGLE_AISTUDIO_CALLBACK_PORT).toBe(51122);
		expect(GOOGLE_AISTUDIO_CALLBACK_PATH).toBe("/oauth2callback");
		expect(GOOGLE_AISTUDIO_SCOPES).toContain("https://www.googleapis.com/auth/generative-language");
		expect(GOOGLE_AISTUDIO_SCOPES).toContain("https://www.googleapis.com/auth/cloud-platform");
	});

	it("formats credentials as bearer access token", () => {
		const creds = {
			access: "ya29.sample_oauth_token_bytes",
			refresh: "sample_refresh",
			expires: Date.now() + 3600000,
		};
		expect(formatGoogleAiStudioApiKey(creds)).toBe("ya29.sample_oauth_token_bytes");
	});

	it("injects Authorization: Bearer header when token begins with ya29.", async () => {
		let capturedHeaders: Record<string, string> = {};
		let capturedUrl: string = "";

		const mockModel: Model<"google-generative-ai"> = {
			id: "gemini-4-argon",
			name: "Gemini 4 Argon",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		};

		const mockContext: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedHeaders = (init?.headers as Record<string, string>) || {};
			return new Response("data: {}\n\n", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const stream = streamGoogle(mockModel, mockContext, {
			apiKey: "ya29.test_bearer_access_token",
			fetch: mockFetch,
		});

		// Consume stream
		for await (const _ of stream) {
			// read until end
		}

		expect(capturedUrl).toContain("/models/gemini-4-argon:streamGenerateContent");
		expect(capturedHeaders["Authorization"]).toBe("Bearer ya29.test_bearer_access_token");
		expect(capturedHeaders["x-goog-api-key"]).toBeUndefined();
	});

	it("injects x-goog-api-key header when token is a traditional API key", async () => {
		let capturedHeaders: Record<string, string> = {};

		const mockModel: Model<"google-generative-ai"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 8_192,
		};

		const mockContext: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = (init?.headers as Record<string, string>) || {};
			return new Response("data: {}\n\n", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const stream = streamGoogle(mockModel, mockContext, {
			apiKey: "AIzaSyFakeApiKey123",
			fetch: mockFetch,
		});

		for await (const _ of stream) {
			// read until end
		}

		expect(capturedHeaders["x-goog-api-key"]).toBe("AIzaSyFakeApiKey123");
		expect(capturedHeaders["Authorization"]).toBeUndefined();
	});
});
