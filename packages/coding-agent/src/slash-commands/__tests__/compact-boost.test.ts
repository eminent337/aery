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
		await boostSpec.handle?.({ name: "boost", args: "", text: "/boost" }, mockRuntime as any);
		expect(currentLevel).toBe("xhigh");
		expect(outputLines[0]).toContain("Reasoning boost ACTIVATED");

		// Check status
		await boostSpec.handle?.({ name: "boost", args: "status", text: "/boost status" }, mockRuntime as any);
		expect(outputLines[1]).toContain("ACTIVE (xhigh)");

		// Turn boost off
		await boostSpec.handle?.({ name: "boost", args: "off", text: "/boost off" }, mockRuntime as any);
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

		await compactSpec.handle?.(
			{ name: "compact", args: "focus on architecture", text: "/compact focus on architecture" },
			mockRuntime as any,
		);
		expect(outputLines[0]).toContain("successfully compacted");
		expect(outputLines[0]).toContain("focus on architecture");
	});

	it("strictly does not register any unofficial slash commands like /heal", () => {
		const healDef = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "heal");
		expect(healDef).toBeUndefined();

		const healSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "heal");
		expect(healSpec).toBeUndefined();
	});

	it("registers all 9 official agy slash commands in builtin registry", () => {
		const agyCommands = ["goal", "compact", "schedule", "browser", "plan", "grill-me", "teamwork", "learn", "boost"];
		for (const cmd of agyCommands) {
			const def = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === cmd);
			expect(def).toBeDefined();
			const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === cmd);
			expect(spec).toBeDefined();
		}
	});

	it("executes /browser with URL and returns prompt to use browser tool", async () => {
		const browserSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "browser")!;
		const result = await browserSpec.handle?.(
			{ name: "browser", args: "https://news.ycombinator.com", text: "/browser https://news.ycombinator.com" },
			{} as any,
		);
		expect(result).toBeDefined();
		expect((result as any).prompt).toContain("https://news.ycombinator.com");
	});

	it("executes /grill-me and returns interactive interview prompt", async () => {
		const grillSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "grill-me")!;
		const result = await grillSpec.handle?.(
			{ name: "grill-me", args: "caching layer", text: "/grill-me caching layer" },
			{ output: async () => {} } as any,
		);
		expect(result).toBeDefined();
		expect((result as any).prompt).toContain("caching layer");
		expect((result as any).prompt).toContain("adversarial requirements and design interview");
	});

	it("executes /teamwork and returns swarm prompt", async () => {
		const teamworkSpec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "teamwork")!;
		const result = await teamworkSpec.handle?.(
			{ name: "teamwork", args: "refactor database schema", text: "/teamwork refactor database schema" },
			{ output: async () => {} } as any,
		);
		expect(result).toBeDefined();
		expect((result as any).prompt).toContain("refactor database schema");
		expect((result as any).prompt).toContain("Codebase Researcher");
	});
});
