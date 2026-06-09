import { describe, expect, it } from "vitest";
import { iconForRole, inferThinkingRole, splitThinkingIntoSteps } from "./thinking-steps";

describe("thinking-steps parsing", () => {
	it("splits heading-based thinking into steps", () => {
		const text = `# Read the source files
I need to examine the configuration.

# Edit the configuration
Now I'll update the settings to match.

# Verify the changes
Finally I'll test that everything works.`;

		const steps = splitThinkingIntoSteps(text);
		expect(steps.length).toBe(3);
		expect(steps[0].summary).toBe("Read the source files");
		expect(steps[1].summary).toBe("Edit the configuration");
		expect(steps[2].summary).toBe("Verify the changes");
	});

	it("splits list-based thinking into steps", () => {
		const text = `- Read the configuration file
- Edit the settings
- Verify the result`;

		const steps = splitThinkingIntoSteps(text);
		expect(steps.length).toBe(3);
	});

	it("returns empty array for empty input", () => {
		expect(splitThinkingIntoSteps("")).toEqual([]);
		expect(splitThinkingIntoSteps("   ")).toEqual([]);
	});

	it("handles single paragraph as one step", () => {
		const text = "Let me read the file to understand the structure and then make changes.";
		const steps = splitThinkingIntoSteps(text);
		expect(steps.length).toBe(1);
		expect(steps[0].summary).toContain("Let me read");
	});

	it("handles double-newline paragraph boundaries", () => {
		const text = `I need to read the source files first. Let me check what's in the config directory.

Now I'll edit the configuration to fix the bug. The issue is in the initialization logic.`;

		const steps = splitThinkingIntoSteps(text);
		expect(steps.length).toBe(2);
	});

	it("derives summary from first line when no heading", () => {
		const text = `Let me check the error logs. There seems to be an issue with the parser.
The parser is failing on line 42 because of an undefined variable.`;

		const steps = splitThinkingIntoSteps(text);
		expect(steps.length).toBeGreaterThanOrEqual(1);
		expect(steps[0].summary).toContain("Let me check");
	});
});

describe("thinking-steps role inference", () => {
	it("detects inspect role", () => {
		expect(inferThinkingRole("Let me read the file")).toBe("inspect");
	});

	it("detects plan role", () => {
		expect(inferThinkingRole("I need to plan the approach")).toBe("plan");
	});

	it("detects write role", () => {
		expect(inferThinkingRole("Now I'll implement the fix")).toBe("write");
	});

	it("detects verify role", () => {
		expect(inferThinkingRole("I should test the changes")).toBe("verify");
	});

	it("detects error role", () => {
		expect(inferThinkingRole("There's a bug in the code")).toBe("error");
	});

	it("returns default for neutral text", () => {
		expect(inferThinkingRole("The system is working")).toBe("default");
	});

	it("returns correct icon for each role", () => {
		expect(iconForRole("inspect")).toBeTruthy();
		expect(iconForRole("plan")).toBeTruthy();
		expect(iconForRole("write")).toBeTruthy();
		expect(iconForRole("error")).toBeTruthy();
	});
});
