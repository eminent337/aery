import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_SLASH_COMMAND_DEFS, BUILTIN_SLASH_COMMANDS_INTERNAL } from "../builtin-registry";

describe("Signature Slash Commands: /grill-me, /learn, /teamwork (ported from agy)", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-slash-test-"));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("registers /grill-me in builtin command registry and emits probe prompt", async () => {
		const def = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "grill-me");
		expect(def).toBeDefined();

		const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "grill-me")!;
		const outputLines: string[] = [];
		const mockRuntime: any = {
			cwd: tempDir,
			output: (text: string) => outputLines.push(text),
		};

		const result = await spec.handle?.(
			{ name: "grill-me", args: "caching strategy", text: "/grill-me caching strategy" },
			mockRuntime,
		);

		expect(outputLines[0]).toContain("Grill-me mode activated");
		expect(result).toBeDefined();
		expect((result as any).prompt).toContain("caching strategy");
		expect((result as any).prompt).toContain("adversarial requirements and design interview");
	});

	it("registers /learn and persists rule file to .agents/rules/", async () => {
		const def = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "learn");
		expect(def).toBeDefined();

		const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "learn")!;
		const outputLines: string[] = [];
		const mockRuntime: any = {
			cwd: tempDir,
			output: (text: string) => outputLines.push(text),
		};

		await spec.handle?.(
			{
				name: "learn",
				args: "typescript-types Always use explicit return types on exported functions",
				text: "/learn typescript-types Always use explicit return types on exported functions",
			},
			mockRuntime,
		);

		expect(outputLines[0]).toContain("Rule saved to .agents/rules/typescript-types.md");

		const savedRulePath = path.join(tempDir, ".agents", "rules", "typescript-types.md");
		const content = await fs.readFile(savedRulePath, "utf-8");
		expect(content).toContain("trigger: model_decision");
		expect(content).toContain("Always use explicit return types");
	});

	it("registers /teamwork and generates multi-agent delegation prompt", async () => {
		const def = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "teamwork");
		expect(def).toBeDefined();

		const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "teamwork")!;
		const outputLines: string[] = [];
		const mockRuntime: any = {
			cwd: tempDir,
			output: (text: string) => outputLines.push(text),
		};

		const result = await spec.handle?.(
			{ name: "teamwork", args: "build auth subsystem", text: "/teamwork build auth subsystem" },
			mockRuntime,
		);

		expect(outputLines[0]).toContain("Teamwork mode activated");
		expect((result as any).prompt).toContain("Codebase Researcher");
		expect((result as any).prompt).toContain("Implementation Engineer");
		expect((result as any).prompt).toContain("QA Tester");
	});
});
