import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { googleAntigravityModelManagerOptions } from "../src/provider-models/google";
import { fetchAntigravityDiscoveryModels } from "../src/utils/discovery/antigravity";

const ENDPOINT = "https://antigravity-test.example.com";

/**
 * Synthetic `fetchAvailableModels` payload exercising every active-filter rule:
 * recommended group members, sort-group-only members (no per-model flag),
 * `defaultAgentModelId` fallback, plus deprecated/internal/denylisted/misc
 * models that must be dropped.
 */
const ACTIVE_MODEL_PAYLOAD = {
	models: {
		// Recommended group members — kept.
		"gemini-3.6-flash-high": { displayName: "Gemini 3.6 Flash High", supportsThinking: true, recommended: true },
		"gemini-pro-agent": { displayName: "Gemini Pro Agent", supportsThinking: true },
		"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", recommended: true },
		// Sort-group-only member (no `recommended` flag) — kept via group walk.
		"gpt-oss-120b-medium": { displayName: "GPT OSS 120B Medium" },
		// defaultAgentModelId fallback — kept even though it is not in a group.
		"gemini-3.6-flash-medium": { displayName: "Gemini 3.6 Flash Medium" },
		// Deprecated — dropped.
		"gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro High", recommended: true },
		// isInternal — dropped.
		chat_20706: { displayName: "Internal Chat", isInternal: true },
		// Denylisted — dropped even though recommended.
		"gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", recommended: true },
		// Special-purpose / inactive — dropped (not recommended, not in a group).
		"gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
		"gemini-3.1-flash-lite": { displayName: "Gemini 3.1 Flash Lite" },
		tab_flash_lite_preview: { displayName: "Tab Flash Lite Preview" },
	},
	agentModelSorts: [
		{
			groups: [
				{
					modelIds: ["gemini-3.6-flash-high", "gemini-pro-agent", "claude-sonnet-4-6", "gpt-oss-120b-medium"],
				},
			],
		},
	],
	defaultAgentModelId: "gemini-3.6-flash-medium",
	deprecatedModelIds: { "gemini-3.1-pro-high": { newModelId: "gemini-pro-agent" } },
} satisfies Record<string, unknown>;

describe("antigravity discovery active-model filter", () => {
	it("keeps only recommended, sort-group, and default agent models", async () => {
		const mockFetcher = (async () =>
			new Response(JSON.stringify(ACTIVE_MODEL_PAYLOAD), { status: 200 })) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: ENDPOINT,
			fetcher: mockFetcher,
		});

		expect(models).not.toBeNull();
		const ids = models!.map(model => model.id).sort();

		expect(ids).toEqual(
			[
				"claude-sonnet-4-6",
				"gemini-3.1-flash-image",
				"gemini-3.1-flash-lite",
				"gemini-3.6-flash-high",
				"gemini-3.6-flash-medium",
				"gemini-pro-agent",
				"gpt-oss-120b-medium",
				"tab_flash_lite_preview",
			].sort(),
		);

		expect(models!.some(model => model.id === "gemini-3.1-pro-high")).toBe(false);
		expect(models!.some(model => model.id === "chat_20706")).toBe(false);
		expect(models!.some(model => model.id === "gemini-2.5-pro")).toBe(false);
	});

	it("normalizes kept models into canonical entries", async () => {
		const mockFetcher = (async () =>
			new Response(JSON.stringify(ACTIVE_MODEL_PAYLOAD), { status: 200 })) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: ENDPOINT,
			fetcher: mockFetcher,
		});

		const gemini = models!.find(model => model.id === "gemini-3.6-flash-high");
		expect(gemini?.api).toBe("google-gemini-cli");
		expect(gemini?.provider).toBe("google-antigravity");
		expect(gemini?.baseUrl).toBe(ENDPOINT);
		expect(gemini?.reasoning).toBe(true);
		expect(gemini?.name).toBe("Gemini 3.6 Flash High (Antigravity)");
	});
});

describe("antigravity discovery static pruning via authoritative fetch", () => {
	it("prunes static-only models when the dynamic fetch succeeds and is authoritative", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "aery-antigravity-discovery-"));
		const dbPath = join(tempDir, "models.db");

		try {
			const now = () => 1_000_000;
			const options = googleAntigravityModelManagerOptions({
				oauthToken: "test-token",
				endpoint: ENDPOINT,
			});

			expect(options.dynamicModelsAuthoritative).toBe(true);

			// Seed a cache row containing a now-deprecated model id that is absent from the live dynamic payload.
			writeModelCache(
				"google-antigravity",
				now(),
				[
					{
						id: "gemini-3.1-pro-high",
						name: "Gemini 3.1 Pro High (Antigravity)",
						api: "google-gemini-cli",
						provider: "google-antigravity",
						baseUrl: ENDPOINT,
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 64_000,
					},
				],
				true,
				"",
				dbPath,
			);

			const mockFetcher = (async () =>
				new Response(JSON.stringify(ACTIVE_MODEL_PAYLOAD), { status: 200 })) as unknown as typeof fetch;

			const result = await resolveProviderModels(
				{
					...options,
					fetchDynamicModels: () =>
						fetchAntigravityDiscoveryModels({
							token: "test-token",
							endpoint: ENDPOINT,
							fetcher: mockFetcher,
						}),
					cacheDbPath: dbPath,
					now,
				},
				"online",
			);

			expect(result.stale).toBe(false);
			const ids = result.models.map(model => model.id);
			expect(ids).toContain("gemini-3.6-flash-high");
			expect(ids).not.toContain("gemini-3.1-pro-high");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
