import { describe, expect, it } from "bun:test";
import { containsThinkTags, filterTaggableText } from "./hide-thinking-text";

describe("containsThinkTags", () => {
	it("returns false for plain text", () => {
		expect(containsThinkTags("Hello, world!")).toBe(false);
	});

	it("returns true for text with think tags", () => {
		expect(
			containsThinkTags(
				"Let me think about this. <think>Hmm, Paris is the capital of France.</think> So the answer is Paris.",
			),
		).toBe(true);
	});

	it("returns true for unclosed think tag", () => {
		expect(containsThinkTags("Let me <think>think about")).toBe(true);
	});

	it("returns false for empty string", () => {
		expect(containsThinkTags("")).toBe(false);
	});
});

describe("filterTaggableText", () => {
	it("returns plain text unchanged", () => {
		expect(filterTaggableText("Hello, world!")).toBe("Hello, world!");
	});

	it("returns empty string unchanged", () => {
		expect(filterTaggableText("")).toBe("");
	});

	describe("hideThinking = false (default)", () => {
		it("strips tags but keeps content visible", () => {
			const result = filterTaggableText(
				"Let me think. <think>Paris is the capital.</think> So the answer is Paris.",
			);
			expect(result).not.toContain("<think>");
			expect(result).not.toContain("</think>");
			expect(result).toContain("Paris is the capital");
			expect(result).toContain("Let me think");
		});

		it("handles multiple think blocks", () => {
			const result = filterTaggableText("<think>First</think> text <think>Second</think> done");
			expect(result).not.toContain("<think>");
			expect(result).not.toContain("</think>");
			expect(result).toContain("First");
			expect(result).toContain("Second");
			expect(result).toContain("text");
		});
	});

	describe("hideThinking = true", () => {
		it("strips entire think block", () => {
			const result = filterTaggableText(
				"Let me think. <think>Hmm, let me reason about this.</think> Here is my answer.",
				true,
			);
			expect(result).not.toContain("<think>");
			expect(result).not.toContain("Hmm, let me reason");
			expect(result).toContain("Let me think");
			expect(result).toContain("Here is my answer");
		});

		it("removes multiple think blocks entirely", () => {
			const result = filterTaggableText("<think>First</think> middle <think>Second</think> end", true);
			expect(result).not.toContain("First");
			expect(result).not.toContain("Second");
			expect(result).toContain("middle");
			expect(result).toContain("end");
		});
	});
});
