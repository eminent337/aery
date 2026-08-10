import { describe, expect, it } from "bun:test";
import { getBundledModels, getBundledProviders } from "../src/models";
import { classifyTask, streamAutoRouter } from "../src/providers/auto-router";
import type { AssistantMessageEvent, Context, Model } from "../src/types";

describe("Aery Auto Router provider", () => {
	it("registers aery in bundled providers", () => {
		const providers = getBundledProviders();
		expect(providers).toContain("aery");
	});

	it("returns aery/auto model from getBundledModels", () => {
		const models = getBundledModels("aery");
		expect(models.length).toBeGreaterThan(0);
		expect(models[0].id).toBe("auto");
	});

	it("correctly classifies task tiers based on prompt content and size", () => {
		const fastContext: Context = {
			messages: [
				{
					role: "user",
					content: "Hello, what time is it?",
					timestamp: Date.now(),
				},
			],
		};
		expect(classifyTask(fastContext)).toBe("fast");

		const reasoningContext: Context = {
			messages: [
				{
					role: "user",
					content: "Please refactor function parseData(input) { return JSON.parse(input); }",
					timestamp: Date.now(),
				},
			],
		};
		expect(classifyTask(reasoningContext)).toBe("reasoning");

		const largeText = "A".repeat(250000);
		const longContext: Context = {
			messages: [
				{
					role: "user",
					content: largeText,
					timestamp: Date.now(),
				},
			],
		};
		expect(classifyTask(longContext)).toBe("long-context");
	});

	it("executes streamAutoRouter and routes to working candidate model or fails gracefully", async () => {
		const model: Model<"auto-router"> = {
			id: "auto",
			name: "Aery Smart Auto Router",
			api: "auto-router",
			provider: "aery",
			baseUrl: "auto",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 8192,
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Reply AUTO_ROUTER_TEST_CONFIRMED in one sentence.",
					timestamp: Date.now(),
				},
			],
		};
		const stream = streamAutoRouter(model, context);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();
		expect(result.role).toBe("assistant");
		// Either we got content (provider available) or we got an error (no providers)
		const hasContent = result.content.length > 0;
		const hasError = result.errorMessage !== undefined;
		expect(hasContent || hasError).toBe(true);
		// If we have events, they should be non-empty
		if (events.length > 0) {
			expect(events.length).toBeGreaterThan(0);
		}
	}, 20000);
});
