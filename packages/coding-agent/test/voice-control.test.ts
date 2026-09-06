import { describe, expect, it } from "bun:test";
import { VoiceControlTool } from "../src/tools/voice-control";

describe("VoiceControlTool", () => {
	const tool = new VoiceControlTool();

	it("has correct tool metadata and schema", () => {
		expect(tool.name).toBe("voice_control");
		expect(tool.approval).toBe("read");
		expect(tool.description).toContain("voice companion tool");
	});

	it("validates required parameters for speak action", async () => {
		const res = await tool.execute("call_1", { action: "speak" });
		expect(res.content[0].type).toBe("text");
		expect((res.content[0] as { text: string }).text).toContain("text");
	});

	it("lists available installed voices", async () => {
		const res = await tool.execute("call_2", { action: "list_voices" });
		expect(res.content[0].type).toBe("text");
		expect(res.details).toBeDefined();
		const details = res.details as { voices: string[] };
		expect(Array.isArray(details.voices)).toBe(true);
		expect(details.voices.length).toBeGreaterThan(0);
	});

	it("handles stop playback command", async () => {
		const res = await tool.execute("call_3", { action: "stop" });
		expect(res.content[0].type).toBe("text");
		expect((res.content[0] as { text: string }).text).toContain("Stopped audio playback");
	});

	it("handles start_ambient, ambient_status, and stop_ambient lifecycle", async () => {
		const startRes = await tool.execute("call_4", { action: "start_ambient" });
		expect(startRes.content[0].type).toBe("text");

		const statusRes = await tool.execute("call_5", { action: "ambient_status" });
		expect(statusRes.content[0].type).toBe("text");
		expect((statusRes.details as any)?.running).toBe(true);

		const stopRes = await tool.execute("call_6", { action: "stop_ambient" });
		expect(stopRes.content[0].type).toBe("text");
		expect((stopRes.details as any)?.running).toBe(false);
	});
});
