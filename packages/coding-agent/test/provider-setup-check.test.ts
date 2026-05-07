import type { Api, Model } from "@eminent337/aery-ai";
import { describe, expect, test } from "vitest";
import type { AuthStatus } from "../src/core/auth-storage.js";
import { checkProviderSetup } from "../src/core/provider-setup-check.js";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function registry(authStatus: AuthStatus, availableModels: Model<Api>[]) {
	return {
		getProviderAuthStatus: () => authStatus,
		getAvailable: () => availableModels,
	};
}

describe("checkProviderSetup", () => {
	test("passes when saved credentials make provider models available", () => {
		const result = checkProviderSetup(
			"anthropic",
			"Anthropic",
			registry({ configured: true, source: "stored" }, [model("anthropic", "claude-sonnet-4-5")]),
		);

		expect(result).toEqual({
			level: "ok",
			message: "Provider check passed for Anthropic: 1 model available.",
		});
	});

	test("fails clearly when Cloudflare account ID is missing", () => {
		const result = checkProviderSetup(
			"cloudflare-workers-ai",
			"Cloudflare Workers AI",
			registry({ configured: false, label: "missing Cloudflare account ID" }, []),
		);

		expect(result).toEqual({
			level: "error",
			message: "Provider check failed for Cloudflare Workers AI: missing Cloudflare account ID.",
		});
	});

	test("warns when credentials are configured but no provider models are available", () => {
		const result = checkProviderSetup(
			"openrouter",
			"OpenRouter",
			registry({ configured: true, source: "stored" }, [model("anthropic", "claude-sonnet-4-5")]),
		);

		expect(result).toEqual({
			level: "warning",
			message: "Provider check could not find available OpenRouter models. Use /model to select or add a model.",
		});
	});
});
