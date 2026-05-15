import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	type SavedCustomOpenAICompatibleProvider,
	saveCustomOpenAICompatibleProvider,
} from "../src/core/custom-openai-compatible.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("custom OpenAI-compatible provider setup", () => {
	let tempDir: string;
	let modelsPath: string;
	let authPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `aery-test-custom-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsPath = join(tempDir, "models.json");
		authPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function readModelsJson(): any {
		return JSON.parse(readFileSync(modelsPath, "utf-8"));
	}

	test("writes a custom OpenAI-compatible provider entry to models.json", () => {
		const saved = saveCustomOpenAICompatibleProvider({
			modelsPath,
			baseUrl: "https://api.example.com/v1",
			modelId: "gpt-4o-mini",
		});

		expect(saved.providerId).toBe("custom-api-example-com-v1");
		expect(saved.modelId).toBe("gpt-4o-mini");

		const json = readModelsJson();
		expect(json.providers[saved.providerId]).toEqual({
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
			models: [
				{
					id: "gpt-4o-mini",
					name: "gpt-4o-mini",
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
		});
	});

	test("reuses an existing provider entry for the same base URL", () => {
		writeFileSync(
			modelsPath,
			JSON.stringify(
				{
					providers: {
						"custom-api-example-com-v1": {
							baseUrl: "https://api.example.com/v1",
							api: "openai-completions",
							models: [{ id: "old-model" }],
						},
					},
				},
				null,
				2,
			),
		);

		const saved = saveCustomOpenAICompatibleProvider({
			modelsPath,
			baseUrl: "https://api.example.com/v1",
			modelId: "new-model",
		});

		expect(saved.providerId).toBe("custom-api-example-com-v1");
		expect(readModelsJson().providers["custom-api-example-com-v1"].models[0].id).toBe("new-model");
	});

	test("removes legacy blank custom provider scaffold when saving a valid provider", () => {
		writeFileSync(
			modelsPath,
			JSON.stringify(
				{
					providers: {
						"custom-openai-compatible": {
							baseUrl: "",
							api: "openai-completions",
							compat: {
								supportsDeveloperRole: false,
								supportsReasoningEffort: false,
							},
							models: [{ id: "", name: "Custom Model" }],
						},
					},
				},
				null,
				2,
			),
		);

		saveCustomOpenAICompatibleProvider({
			modelsPath,
			baseUrl: "https://api.example.com/v1",
			modelId: "gpt-4o-mini",
		});

		const providers = readModelsJson().providers;
		expect(providers["custom-openai-compatible"]).toBeUndefined();
		expect(providers["custom-api-example-com-v1"]).toBeDefined();
	});

	test("custom providers defined in models.json can authenticate via auth.json", () => {
		const saved: SavedCustomOpenAICompatibleProvider = saveCustomOpenAICompatibleProvider({
			modelsPath,
			baseUrl: "https://api.example.com/v1",
			modelId: "gpt-4o-mini",
		});
		const authStorage = AuthStorage.create(authPath);
		authStorage.set(saved.providerId, { type: "api_key", key: "sk-test" });

		const registry = ModelRegistry.create(authStorage, modelsPath);
		const model = registry.find(saved.providerId, saved.modelId);

		expect(registry.getError()).toBeUndefined();
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe("https://api.example.com/v1");
		expect(model && registry.hasConfiguredAuth(model)).toBe(true);
	});
});
