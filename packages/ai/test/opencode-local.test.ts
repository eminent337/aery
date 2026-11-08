import { describe, expect, it } from "bun:test";
import { isLocalOpenCodeAvailable, streamOpenCodeLocalCli } from "../src/providers/opencode-local";
import type { Context, Model } from "../src/types";

describe("opencode local provider", () => {
	it("detects local opencode installation", () => {
		expect(isLocalOpenCodeAvailable()).toBe(true);
	});

	it("streams response from local opencode CLI", async () => {
		const model: Model<"openai-completions"> = {
			id: "nemotron-3.5-lightning-free",
			name: "Nemotron 3.5 Lightning Free",
			api: "openai-completions",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/inference/openai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 262144,
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Reply with the single word: LOCAL_VERIFIED",
				},
			],
		};

		const stream = streamOpenCodeLocalCli(model, context);
		const deltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") {
				deltas.push(event.delta);
			}
		}

		const fullResult = await stream.result();
		const text = deltas.join("");
		expect(text).toContain("LOCAL_VERIFIED");
		expect(fullResult.stopReason).toBe("stop");
	}, 20000);
});
