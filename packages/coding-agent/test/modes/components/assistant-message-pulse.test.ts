import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@aryee337/aery/config/settings";
import { AssistantMessageComponent } from "@aryee337/aery/modes/components/assistant-message";
import { initTheme } from "@aryee337/aery/modes/theme/theme";
import type { AssistantMessage } from "@aryee337/aery-ai";

const RENDER_WIDTH = 80;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("AssistantMessageComponent streaming thinking pulse", () => {
	function streaming(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function liveLines(message: AssistantMessage, hideThinkingBlock = true): string[] {
		const component = new AssistantMessageComponent(undefined, hideThinkingBlock);
		component.updateContent(message);
		const lines = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
			.split("\n")
			.map((line: string) => line.trimEnd());
		return lines;
	}

	const PULSE = "▁";

	it("shows the pulse in place of hidden reasoning while thinking streams", () => {
		const lines = liveLines(streaming([{ type: "thinking", thinking: "private reasoning" }]));
		expect(lines.some((line: string) => line.includes(PULSE))).toBe(true);
		expect(lines.some((line: string) => line.includes("private reasoning"))).toBe(false);
	});

	it("drops the pulse once visible text starts streaming", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			]),
		);
		expect(lines.some((line: string) => line.includes(PULSE))).toBe(false);
		expect(lines.some((line: string) => line.includes("Visible answer"))).toBe(true);
	});

	it("does not show the pulse when thinking is visible", () => {
		const lines = liveLines(streaming([{ type: "thinking", thinking: "private reasoning" }]), false);
		expect(lines.some((line: string) => line.includes(PULSE))).toBe(false);
		expect(lines.some((line: string) => line.includes("private reasoning"))).toBe(true);
	});

	it("does not show the pulse once a tool call streams", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
			]),
		);
		expect(lines.some((line: string) => line.includes(PULSE))).toBe(false);
	});

	it("removes the pulse when the block is finalized", () => {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(streaming([{ type: "thinking", thinking: "private reasoning" }]));
		expect(Bun.stripANSI(component.render(RENDER_WIDTH).join("\n")).includes(PULSE)).toBe(true);

		component.markTranscriptBlockFinalized();
		const afterFinalize = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(afterFinalize.includes(PULSE)).toBe(false);
		expect(afterFinalize.includes("private reasoning")).toBe(false);
	});

	it("keeps the pulse across thinking deltas on a reused component, then yields to text", () => {
		const component = new AssistantMessageComponent(undefined, true);
		const rendered = () => Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }]));
		expect(rendered().includes(PULSE)).toBe(true);
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }]));
		expect(rendered().includes(PULSE)).toBe(true);
		component.updateContent(
			streaming([
				{ type: "thinking", thinking: "abc" },
				{ type: "text", text: "Answer" },
			]),
		);
		expect(rendered().includes(PULSE)).toBe(false);
		expect(rendered().includes("Answer")).toBe(true);
	});
});
