import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";

describe("CLI Tool Filtering & Minimal Flags", () => {
	it("should parse --allowed-tools into an array of lowercase strings", () => {
		const parsed = parseArgs(["--allowed-tools", "bash,read,edit"]);
		expect(parsed.allowedTools).toEqual(["bash", "read", "edit"]);
	});

	it("should parse --disallowed-tools into an array of lowercase strings", () => {
		const parsed = parseArgs(["--disallowed-tools", "write,bash"]);
		expect(parsed.disallowedTools).toEqual(["write", "bash"]);
	});

	it("should parse --bare flag and enable minimal mode", () => {
		const parsed = parseArgs(["--bare"]);
		expect(parsed.bare).toBe(true);
		expect(parsed.noExtensions).toBe(true);
		expect(parsed.noSkills).toBe(true);
		expect(parsed.noRules).toBe(true);
		expect(parsed.noLsp).toBe(true);
		expect(process.env.AERY_SIMPLE).toBe("1");
	});

	it("should parse --worktree and -w flag", () => {
		const parsed1 = parseArgs(["--worktree", "feature-x"]);
		expect(parsed1.worktree).toBe("feature-x");

		const parsed2 = parseArgs(["-w"]);
		expect(parsed2.worktree).toBe(true);
	});

	it("should parse --bg and --background flag", () => {
		const parsed1 = parseArgs(["--bg", "Fix tests"]);
		expect(parsed1.bg).toBe(true);
		expect(parsed1.messages).toContain("Fix tests");

		const parsed2 = parseArgs(["--background", "Refactor"]);
		expect(parsed2.bg).toBe(true);
		expect(parsed2.messages).toContain("Refactor");
	});
});
