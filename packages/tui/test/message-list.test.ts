import { describe, expect, it } from "bun:test";
import { MessageList } from "../src/components/message-list";

describe("MessageList", () => {
	it("renders empty for no messages", () => {
		expect(new MessageList().render(80)).toEqual([]);
	});

	it("user message contains amber color code", () => {
		const ml = new MessageList();
		ml.appendMessage({ role: "user", content: "Hello" });
		const lines = ml.render(40);
		expect(lines.some(l => l.includes("\x1b[38;5;214m"))).toBe(true);
	});

	it("assistant message contains cyan color code", () => {
		const ml = new MessageList();
		ml.appendMessage({ role: "assistant", content: "Hi" });
		const lines = ml.render(40);
		expect(lines.some(l => l.includes("\x1b[38;5;80m"))).toBe(true);
	});

	it("appendChunk streams onto last assistant message", () => {
		const ml = new MessageList();
		ml.appendMessage({ role: "assistant", content: "" });
		ml.appendChunk("Hello");
		ml.appendChunk(" world");
		expect(ml.render(80).join(" ")).toContain("Hello world");
	});

	it("clear removes all messages", () => {
		const ml = new MessageList();
		ml.appendMessage({ role: "user", content: "x" });
		ml.clear();
		expect(ml.render(80)).toEqual([]);
	});
});
