import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DEFS, BUILTIN_SLASH_COMMANDS_INTERNAL } from "../builtin-registry";

describe("Slash Commands: /compact & /boost (ported from agy)", () => {
	it("registers /compact in builtin command registry and metadata defs", () => {
		const compactDef = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "compact");
		expect(compactDef).toBeDefined();
		expect(compactDef?.description).toContain("Compact conversation context");

		const compactSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "compact");
		expect(compactSpec).toBeDefined();
		expect(typeof compactSpec?.handle).toBe("function");
		expect(typeof compactSpec?.handleTui).toBe("function");
	});

	it("registers /boost in builtin command registry with subcommands", () => {
		const boostDef = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "boost");
		expect(boostDef).toBeDefined();
		expect(boostDef?.description).toContain("Boost reasoning depth");
		expect(boostDef?.subcommands?.map(s => s.name)).toEqual(["on", "off", "status"]);

		const boostSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "boost");
		expect(boostSpec).toBeDefined();
		expect(typeof boostSpec?.handle).toBe("function");
		expect(typeof boostSpec?.handleTui).toBe("function");
	});

	it("executes /boost handle and modifies thinking level", async () => {
		const boostSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "boost")!;
		let currentLevel: string | undefined;
		const outputLines: string[] = [];

		const mockRuntime: any = {
			session: {
				get thinkingLevel() {
					return currentLevel;
				},
				setThinkingLevel(level: string) {
					currentLevel = level;
				},
			},
			output: (text: string) => {
				outputLines.push(text);
			},
		};

		// Turn boost on
		await boostSpec.handle({ name: "boost", args: "", text: "/boost" }, mockRuntime);
		expect(currentLevel).toBe("xhigh");
		expect(outputLines[0]).toContain("Reasoning boost ACTIVATED");

		// Check status
		await boostSpec.handle({ name: "boost", args: "status", text: "/boost status" }, mockRuntime);
		expect(outputLines[1]).toContain("ACTIVE (xhigh)");

		// Turn boost off
		await boostSpec.handle({ name: "boost", args: "off", text: "/boost off" }, mockRuntime);
		expect(currentLevel).toBe("medium");
		expect(outputLines[2]).toContain("Reasoning boost disabled");
	});

	it("executes /compact handle", async () => {
		const compactSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "compact")!;
		const outputLines: string[] = [];

		const mockRuntime: any = {
			session: {
				compact: async (instructions?: string) => ({
					summary: `Compacted summary with instructions: ${instructions ?? "none"}`,
				}),
			},
			output: (text: string) => {
				outputLines.push(text);
			},
		};

		await compactSpec.handle(
			{ name: "compact", args: "focus on architecture", text: "/compact focus on architecture" },
			mockRuntime,
		);
		expect(outputLines[0]).toContain("successfully compacted");
		expect(outputLines[0]).toContain("focus on architecture");
	});
});
