import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../../registry/agent-registry";
import { MentionResolver } from "../mention-resolver";

describe("Context @ Mentions Resolver (ported from agy)", () => {
	let testDir: string;
	let resolver: MentionResolver;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `aery-mentions-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		fs.mkdirSync(testDir, { recursive: true });
		resolver = MentionResolver.getInstance();
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("expands @file:path and implicit @file.ext in user prompt", async () => {
		const sampleFile = path.join(testDir, "app.config.json");
		fs.writeFileSync(sampleFile, JSON.stringify({ port: 3000, debug: true }, null, 2));

		const prompt = "Please review @file:app.config.json and suggest updates.";
		const result = await resolver.resolveMentions(prompt, testDir);

		expect(result.mentions.length).toBe(1);
		expect(result.mentions[0].type).toBe("file");
		expect(result.mentions[0].identifier).toBe("app.config.json");
		expect(result.expandedPrompt).toContain("[File: app.config.json]");
		expect(result.expandedPrompt).toContain('"port": 3000');
	});

	it("expands @dir:path listing directory tree", async () => {
		const subDir = path.join(testDir, "models");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "user.ts"), "export interface User {}");
		fs.writeFileSync(path.join(subDir, "post.ts"), "export interface Post {}");

		const prompt = "Check the files in @dir:models.";
		const result = await resolver.resolveMentions(prompt, testDir);

		expect(result.mentions.length).toBe(1);
		expect(result.mentions[0].type).toBe("dir");
		expect(result.expandedPrompt).toContain("[Directory: models]");
		expect(result.expandedPrompt).toContain("user.ts");
		expect(result.expandedPrompt).toContain("post.ts");
	});

	it("expands @rule:name from .agents/rules/", async () => {
		const rulesDir = path.join(testDir, ".agents", "rules");
		fs.mkdirSync(rulesDir, { recursive: true });
		fs.writeFileSync(
			path.join(rulesDir, "clean-architecture.md"),
			"# Clean Architecture\nAlways keep domain separate from infrastructure.",
		);

		const prompt = "Adhere to @rule:clean-architecture when writing the service.";
		const result = await resolver.resolveMentions(prompt, testDir);

		expect(result.mentions.length).toBe(1);
		expect(result.mentions[0].type).toBe("rule");
		expect(result.expandedPrompt).toContain("[Rule: clean-architecture]");
		expect(result.expandedPrompt).toContain("Always keep domain separate from infrastructure.");
	});

	it("expands @agent:id from active AgentRegistry", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "researcher-01",
			displayName: "Codebase Researcher",
			kind: "sub",
			status: "idle",
			session: null,
		});

		const prompt = "Coordinate task with @agent:researcher-01.";
		const result = await resolver.resolveMentions(prompt, testDir);

		expect(result.mentions.length).toBe(1);
		expect(result.mentions[0].type).toBe("agent");
		expect(result.expandedPrompt).toContain("[Agent Context: researcher-01]");
		expect(result.expandedPrompt).toContain("Codebase Researcher");
	});

	it("returns original prompt unchanged when no @ mentions are present", async () => {
		const prompt = "Build a simple hello world script in TypeScript.";
		const result = await resolver.resolveMentions(prompt, testDir);

		expect(result.mentions.length).toBe(0);
		expect(result.expandedPrompt).toBe(prompt);
	});
});
