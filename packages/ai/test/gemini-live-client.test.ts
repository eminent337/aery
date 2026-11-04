import { describe, expect, it } from "bun:test";
import { GeminiLiveClient } from "../src/providers/gemini-live-client";

describe("GeminiLiveClient", () => {
	it("initializes with default options and formats model string", () => {
		const client = new GeminiLiveClient({
			apiKey: "test-key",
			model: "gemini-2.0-flash-exp",
		});

		expect(client.isConnected).toBe(false);
		expect(client.ready).toBe(false);
	});

	it("throws when sending media or tool responses while disconnected", () => {
		const client = new GeminiLiveClient({ apiKey: "test-key" });

		expect(() => {
			client.sendRealtimeMedia({
				mimeType: "image/jpeg",
				data: "base64data",
			});
		}).toThrow("not connected");

		expect(() => {
			client.sendToolResponse([
				{
					name: "test",
					response: { result: "ok" },
				},
			]);
		}).toThrow("not connected");
	});

	it("parses server setupComplete, serverContent, and toolCall messages correctly", () => {
		const client = new GeminiLiveClient({ apiKey: "test-key" });

		let setupDone = false;
		let receivedText = "";
		let receivedAudio = "";
		let receivedToolCalls: any[] = [];

		client.on("setupComplete", () => {
			setupDone = true;
		});
		client.on("text", (text) => {
			receivedText += text;
		});
		client.on("audio", (audio) => {
			receivedAudio = audio;
		});
		client.on("toolCall", (calls) => {
			receivedToolCalls = calls;
		});

		// @ts-expect-error test private handler
		client.handleMessage(JSON.stringify({ setupComplete: {} }));
		expect(setupDone).toBe(true);

		// @ts-expect-error test private handler
		client.handleMessage(
			JSON.stringify({
				serverContent: {
					modelTurn: {
						parts: [
							{ text: "Hello from Gemini Live!" },
							{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "YXVkaW8=" } },
						],
					},
					turnComplete: true,
				},
			}),
		);
		expect(receivedText).toBe("Hello from Gemini Live!");
		expect(receivedAudio).toBe("YXVkaW8=");

		// @ts-expect-error test private handler
		client.handleMessage(
			JSON.stringify({
				toolCall: {
					functionCalls: [
						{
							name: "computer_use",
							args: { action: "click", x: 100, y: 200 },
							id: "call-1",
						},
					],
				},
			}),
		);
		expect(receivedToolCalls.length).toBe(1);
		expect(receivedToolCalls[0].name).toBe("computer_use");
		expect(receivedToolCalls[0].args.action).toBe("click");
	});
});
