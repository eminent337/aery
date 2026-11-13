import { describe, expect, it, mock } from "bun:test";
import { parseGeminiCliCredentials } from "../src/providers/google-gemini-cli";

describe("google-gemini-cli credential parsing", () => {
	it("parses valid JSON credentials with token and projectId", () => {
		const raw = JSON.stringify({
			token: "ya29.test-access-token",
			projectId: "my-custom-project",
		});
		const result = parseGeminiCliCredentials(raw);
		expect(result.accessToken).toBe("ya29.test-access-token");
		expect(result.projectId).toBe("my-custom-project");
	});

	it("parses raw AIza API key without requiring JSON envelope", () => {
		const rawKey = "AIzaSyFakeGoogleApiKeyForTesting123456";
		const result = parseGeminiCliCredentials(rawKey);
		expect(result.accessToken).toBe(rawKey);
		expect(result.projectId).toBe("default-cli-project");
	});

	it("parses raw bearer token string without requiring JSON envelope", () => {
		const rawToken = "ya29.a0AehfTOlBHby5nnE200EkrF4XKyD";
		const result = parseGeminiCliCredentials(rawToken);
		expect(result.accessToken).toBe(rawToken);
		expect(result.projectId).toBe("default-cli-project");
	});

	it("parses JSON credentials with apiKey field and defaults projectId", () => {
		const raw = JSON.stringify({
			apiKey: "AIzaSyFakeKeyInsideJson",
		});
		const result = parseGeminiCliCredentials(raw);
		expect(result.accessToken).toBe("AIzaSyFakeKeyInsideJson");
		expect(result.projectId).toBe("default-cli-project");
	});

	it("parses JSON credentials with key field and defaults projectId", () => {
		const raw = JSON.stringify({
			key: "AIzaSyFakeKeyField",
		});
		const result = parseGeminiCliCredentials(raw);
		expect(result.accessToken).toBe("AIzaSyFakeKeyField");
		expect(result.projectId).toBe("default-cli-project");
	});

	it("throws on empty JSON object missing token", () => {
		expect(() => parseGeminiCliCredentials("{}")).toThrow(
			"Missing token or projectId in Google Cloud credentials",
		);
	});
});

describe("streamGoogleGeminiCli routing with API key", () => {
	it("routes to Google Generative AI when an AIza API key is provided", async () => {
		const { streamGoogleGeminiCli } = await import("../src/providers/google-gemini-cli");

		const model: any = {
			id: "gemini-2.5-flash",
			provider: "google-antigravity",
			api: "google-gemini-cli",
			input: ["text", "image"],
		};
		const context: any = {
			messages: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }],
		};

		let requestedUrl = "";
		let requestedHeaders: Record<string, string> = {};

		const stream = streamGoogleGeminiCli(model, context, {
			apiKey: "AIzaSyTestKey123456789",
			fetch: async (url, init) => {
				requestedUrl = String(url);
				requestedHeaders = (init?.headers as Record<string, string>) || {};
				return new Response(
					'data: {"candidates":[{"content":{"parts":[{"text":"Hello from AI Studio"}]}}]}\n\n',
					{
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			},
		});

		const deltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") {
				deltas.push(event.delta);
			}
		}

		expect(requestedUrl).toContain("generativelanguage.googleapis.com");
		expect(requestedHeaders["x-goog-api-key"]).toBe("AIzaSyTestKey123456789");
		expect(deltas.join("")).toBe("Hello from AI Studio");
	});
});
