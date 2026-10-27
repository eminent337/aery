import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash } from "../../../exec/bash-executor";
import { PermissionEngine } from "../permission-engine";

describe("Fine-Grained Permission & Workspace Trust Engine (ported from agy)", () => {
	let testDir: string;
	let engine: PermissionEngine;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `aery-perm-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		fs.mkdirSync(testDir, { recursive: true });
		engine = PermissionEngine.getInstance();
		engine.clear();
	});

	afterEach(() => {
		engine.clear();
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("enforces command allow and deny rules", () => {
		engine.configure({
			permissions: {
				allow: ["command(git *)", "command(npm test)", "command(cat)"],
				deny: ["command(git push --force)"],
			},
		});

		expect(engine.checkCommand("git status").allowed).toBe(true);
		expect(engine.checkCommand("git log -n 5").allowed).toBe(true);
		expect(engine.checkCommand("npm test").allowed).toBe(true);
		expect(engine.checkCommand("cat README.md").allowed).toBe(true);

		// Explicit deny takes precedence
		const denied = engine.checkCommand("git push --force origin main");
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toContain("explicit deny rule");

		// Unlisted command denied when allowlist exists
		const unlisted = engine.checkCommand("curl https://example.com");
		expect(unlisted.allowed).toBe(false);
		expect(unlisted.reason).toContain("does not match any allowed command grants");
	});

	it("supports command('*') global wildcard", () => {
		engine.configure({
			permissions: {
				allow: ["command('*')"],
				deny: ["command(rm -rf /)"],
			},
		});

		expect(engine.checkCommand("ls -la").allowed).toBe(true);
		expect(engine.checkCommand("bun test").allowed).toBe(true);
		expect(engine.checkCommand("rm -rf /").allowed).toBe(false);
	});

	it("enforces allowNonWorkspaceAccess false against external directories", () => {
		const workspace = path.join(testDir, "project");
		const outsideDir = path.join(testDir, "outside");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });

		engine.configure({
			allowNonWorkspaceAccess: false,
			trustedWorkspaces: [workspace],
		});

		// Inside workspace: permitted
		const inside = engine.checkFileAccess(path.join(workspace, "src", "index.ts"), "read", workspace);
		expect(inside.allowed).toBe(true);

		// Outside workspace and untrusted: blocked
		const outside = engine.checkFileAccess(path.join(outsideDir, "secret.txt"), "read", workspace);
		expect(outside.allowed).toBe(false);
		expect(outside.reason).toContain("non-workspace path access is disabled");
	});

	it("enforces MCP tool permissions", () => {
		engine.configure({
			permissions: {
				allow: ["mcp(obsidian/*)", "mcp(github/get_issue)"],
				deny: ["mcp(obsidian/delete_note)"],
			},
		});

		expect(engine.checkMcp("obsidian", "search_vault").allowed).toBe(true);
		expect(engine.checkMcp("github", "get_issue").allowed).toBe(true);
		expect(engine.checkMcp("github", "delete_repo").allowed).toBe(false);

		// Explicit deny takes precedence
		expect(engine.checkMcp("obsidian", "delete_note").allowed).toBe(false);
	});

	it("intercepts executeBash when command is not permitted", async () => {
		engine.configure({
			permissions: {
				allow: ["command(git status)"],
			},
		});

		const res = await executeBash("echo 'unauthorized command'", {
			cwd: testDir,
			skipPolicyGuardian: true,
			skipHooks: true,
		});

		expect(res.exitCode).toBe(1);
		expect(res.output).toContain("does not match any allowed command grants");
	});
});
