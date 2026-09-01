import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@aryee337/aery/config/model-registry";
import { AuthStorage } from "@aryee337/aery/session/auth-storage";
import { hookFetch, Snowflake } from "@aryee337/aery-utils";

/**
 * Models that advertise no chat-capable endpoint in `supported_endpoint_types`
 * (e.g. Agnes's `agnes-image-2.5-flash` advertises `[]` and its gateway 400s
 * with "Use /v1/images/generations") must NOT be registered as chat models by
 * openai-models-list discovery — doing so only produces guaranteed failures in
 * the model picker. Models that omit the field entirely (older proxies) keep
 * the provider-level api fallback.
 */
describe("proxy discovery skips non-chat endpoint models", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `aery-test-nonchat-endpoint-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("image/video-only models register as imageOnly and stay out of chat selection", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  agnes-proxy:",
				"    baseUrl: https://apihub.agnes-ai.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "https://apihub.agnes-ai.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(
				JSON.stringify({
					data: [
						// Image-only: advertises no chat endpoint at all.
						{ id: "agnes-image-2.5-flash", supported_endpoint_types: [] },
						// Video models advertise openai but are video-only (400 on chat).
						{ id: "agnes-video-2.5-flash", supported_endpoint_types: ["openai"] },
						// Agnes 400s image models on chat even when they claim ["openai"].
						{ id: "agnes-image-2.0-flash", supported_endpoint_types: ["openai"] },
						// Plain chat model.
						{ id: "agnes-2.5-flash", supported_endpoint_types: ["openai"] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("agnes-proxy");

		// Registered internally (image generation can target them)...
		const image25 = registry.find("agnes-proxy", "agnes-image-2.5-flash");
		const video25 = registry.find("agnes-proxy", "agnes-video-2.5-flash");
		const image20 = registry.find("agnes-proxy", "agnes-image-2.0-flash");
		expect(image25?.imageOnly).toBe(true);
		expect(video25?.imageOnly).toBe(true);
		expect(image20?.imageOnly).toBe(true);
		expect(image25?.input).toEqual(["image"]);
		// ...but hidden from chat model selection.
		const availableIds = new Set(registry.getAvailable().map(model => `${model.provider}/${model.id}`));
		expect(availableIds.has("agnes-proxy/agnes-image-2.5-flash")).toBe(false);
		expect(availableIds.has("agnes-proxy/agnes-video-2.5-flash")).toBe(false);
		expect(availableIds.has("agnes-proxy/agnes-image-2.0-flash")).toBe(false);
		expect(availableIds.has("agnes-proxy/agnes-2.5-flash")).toBe(true);
	});

	test("missing supported_endpoint_types still falls back to the provider api", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  old-proxy:",
				"    baseUrl: https://old.example.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "https://old.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			// No supported_endpoint_types field at all.
			return new Response(JSON.stringify({ data: [{ id: "legacy-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("old-proxy");

		expect(registry.find("old-proxy", "legacy-model")).toBeDefined();
	});
});
