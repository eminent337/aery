import { describe, expect, it } from "vitest";
import { collapseCommand } from "./bash-collapse";

describe("collapseCommand", () => {
	it("returns empty string for undefined", () => {
		expect(collapseCommand(undefined)).toBe("");
	});

	it("returns empty string for empty string", () => {
		expect(collapseCommand("")).toBe("");
	});

	it("returns single-line command unchanged", () => {
		expect(collapseCommand("git status")).toBe("git status");
	});

	it("collapses newlines into visual separator", () => {
		const result = collapseCommand("echo hello\necho world");
		expect(result).toContain("⏎");
	});

	it("collapses multiple consecutive newlines into one separator", () => {
		const result = collapseCommand("a\n\n\nb");
		expect(result).toContain("⏎");
		expect(result.split("⏎").length).toBe(2);
	});

	it("handles command with leading/trailing whitespace", () => {
		const result = collapseCommand("  echo hello\necho world  ");
		expect(result).toContain("⏎");
	});
});
