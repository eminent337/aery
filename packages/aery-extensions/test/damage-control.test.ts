import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";
import damageControl, { isGitPath, loadConfig } from "../src/core/damage-control";

interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

function createMockAery() {
	let handler:
		| ((
				event: { toolName: string; input: any },
				ctx: any,
		  ) => Promise<ToolCallResult | undefined> | ToolCallResult | undefined)
		| null = null;

	const mockApi = {
		on: (event: string, fn: any) => {
			if (event === "tool_call") {
				handler = fn;
			}
		},
	} as unknown as ExtensionAPI;

	return {
		api: mockApi,
		callTool: async (toolName: string, input: any) => {
			if (!handler) throw new Error("Handler not registered");
			return await handler({ toolName, input }, {});
		},
	};
}

describe("damage-control: blockGitWrites", () => {
	it("blocks write to .git/config and .git/hooks/pre-commit by default", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api);

		const expectedReason =
			"Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).";

		const resConfig = await callTool("write", {
			path: ".git/config",
			content: "[core]\nrepositoryformatversion = 0",
		});
		expect(resConfig).toBeDefined();
		expect(resConfig?.block).toBe(true);
		expect(resConfig?.reason).toBe(expectedReason);

		const resHook = await callTool("write", {
			path: ".git/hooks/pre-commit",
			content: "#!/bin/sh\nexit 0",
		});
		expect(resHook).toBeDefined();
		expect(resHook?.block).toBe(true);
		expect(resHook?.reason).toBe(expectedReason);
	});

	it("blocks edit to .git/index by default", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api);

		const resEdit = await callTool("edit", {
			path: ".git/index",
			target: "foo",
			replacement: "bar",
		});
		expect(resEdit).toBeDefined();
		expect(resEdit?.block).toBe(true);
		expect(resEdit?.reason).toBe(
			"Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).",
		);
	});

	it("blocks bash commands mutating .git directly (rm -rf .git, redirection into .git/)", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api);

		const resRm = await callTool("bash", { command: "rm -rf .git" });
		expect(resRm).toBeDefined();
		expect(resRm?.block).toBe(true);
		expect(resRm?.reason).toContain(
			"Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).",
		);
		expect(resRm?.reason).toContain("rm -rf .git");

		const resRedirect = await callTool("bash", {
			command: "echo 'payload' > .git/hooks/pre-commit",
		});
		expect(resRedirect).toBeDefined();
		expect(resRedirect?.block).toBe(true);
		expect(resRedirect?.reason).toContain(
			"Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).",
		);
		expect(resRedirect?.reason).toContain("echo 'payload' > .git/hooks/pre-commit");
	});

	it("blocks destructive git clean and checkout force commands", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api);

		const resClean = await callTool("bash", { command: "git clean -fd" });
		expect(resClean).toBeDefined();
		expect(resClean?.block).toBe(true);
		expect(resClean?.reason).toContain(
			"Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).",
		);

		const resCheckout = await callTool("bash", {
			command: "git checkout -f",
		});
		expect(resCheckout).toBeDefined();
		expect(resCheckout?.block).toBe(true);
		expect(resCheckout?.reason).toContain(
			"Blocked by damage control: direct writes to .git metadata are forbidden (blockGitWrites).",
		);
	});

	it("allows normal file writes (src/index.ts, README.md)", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api);

		const resSrc = await callTool("write", {
			path: "src/index.ts",
			content: "export const version = '1.0.0';",
		});
		expect(resSrc).toBeUndefined();

		const resReadme = await callTool("write", {
			path: "README.md",
			content: "# Project Docs",
		});
		expect(resReadme).toBeUndefined();
	});

	it("allows standard git commands (git status, diff, log, add, commit)", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api);

		const safeCommands = ["git status", "git diff", "git log -n 5", "git add .", "git commit -m 'feat: add feature'"];

		for (const command of safeCommands) {
			const res = await callTool("bash", { command });
			expect(res).toBeUndefined();
		}
	});

	it("allows .git writes and bash commands when allow_git_writes is true", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api, { allow_git_writes: true });

		const resWrite = await callTool("write", {
			path: ".git/config",
			content: "# custom config",
		});
		expect(resWrite).toBeUndefined();

		const resEdit = await callTool("edit", {
			path: ".git/index",
			target: "a",
			replacement: "b",
		});
		expect(resEdit).toBeUndefined();

		const resRm = await callTool("bash", { command: "rm -rf .git" });
		expect(resRm).toBeUndefined();

		const resEcho = await callTool("bash", {
			command: "echo 'payload' > .git/hooks/pre-commit",
		});
		expect(resEcho).toBeUndefined();
	});

	it("correctly identifies git paths via isGitPath helper", () => {
		expect(isGitPath(".git")).toBe(true);
		expect(isGitPath(".git/config")).toBe(true);
		expect(isGitPath("./.git/HEAD")).toBe(true);
		expect(isGitPath(".git/hooks/pre-commit")).toBe(true);
		expect(isGitPath("nested/repo/.git/index")).toBe(true);

		expect(isGitPath("src/index.ts")).toBe(false);
		expect(isGitPath("README.md")).toBe(false);
		expect(isGitPath(".gitignore")).toBe(false);
		expect(isGitPath(".github/workflows/ci.yml")).toBe(false);
		expect(isGitPath("git-helper.ts")).toBe(false);
	});

	it("loads allow_git_writes from yaml configuration", () => {
		const tempDir = join(tmpdir(), `dc-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const configPath = join(tempDir, "damage-control.yaml");

		try {
			writeFileSync(configPath, "allow_git_writes: true\nblock:\n  - dangerous-tool\n");
			const config = loadConfig(configPath);
			expect(config.allow_git_writes).toBe(true);
			expect(config.block).toEqual(["dangerous-tool"]);

			writeFileSync(configPath, "allow_git_writes: false\n");
			const configDisabled = loadConfig(configPath);
			expect(configDisabled.allow_git_writes).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
