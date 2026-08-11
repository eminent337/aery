import { describe, expect, it } from "bun:test";
import { getBundledModels, getBundledProviders } from "../src/models";
import { streamKiro } from "../src/providers/kiro";
import type { Context, Model } from "../src/types";

describe("Kiro CLI provider", () => {
	it("registers kiro in bundled providers", () => {
		const providers = getBundledProviders();
		expect(providers).toContain("kiro");
	});

	it("returns kiro models from getBundledModels", () => {
		const models = getBundledModels("kiro");
		expect(models.length).toBeGreaterThan(0);
		const ids = models.map(m => m.id);
		expect(ids).toContain("claude-sonnet-4.5");
		expect(ids).toContain("claude-sonnet-4");
		expect(ids).toContain("claude-haiku-4.5");
	});

	it("executes streamKiro and returns streamed events from kiro-cli or handles unauthenticated state", async () => {
		const model: Model<"kiro-cli"> = {
			id: "claude-sonnet-4.5",
			name: "Claude Sonnet 4.5",
			api: "kiro-cli",
			provider: "kiro",
			baseUrl: "local",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Say HELLO_KIRO_TEST in one word.",
					timestamp: Date.now(),
				},
			],
		};
		const stream = streamKiro(model, context);
		const events = [];
		try {
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();
			expect(result.role).toBe("assistant");
			expect(result.content.length).toBeGreaterThan(0);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain("Kiro CLI is not authenticated");
		}
	}, 15000);

	it("strips the kiro/ provider prefix before invoking the CLI", async () => {
		const model: Model<"kiro-cli"> = {
			id: "kiro/claude-haiku-4.5",
			name: "Claude Haiku 4.5 (Kiro CLI)",
			api: "kiro-cli",
			provider: "kiro",
			baseUrl: "local",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Say KIRO_PREFIX_TEST in one word.",
					timestamp: Date.now(),
				},
			],
		};
		const stream = streamKiro(model, context);
		try {
			for await (const _event of stream) {
				// draining; result() below asserts the response
			}
			const result = await stream.result();
			expect(result.role).toBe("assistant");
			const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
			expect(text.toUpperCase()).toContain("KIRO_PREFIX_TEST");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain("Kiro CLI is not authenticated");
		}
	}, 15000);
});
