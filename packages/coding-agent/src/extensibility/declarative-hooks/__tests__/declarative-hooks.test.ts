import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash } from "../../../exec/bash-executor";
import { DeclarativeHooksEngine } from "../engine";
import type { HooksJsonFile } from "../types";

describe("Declarative hooks.json Engine (ported from agy)", () => {
	let testDir: string;
	let engine: DeclarativeHooksEngine;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `aery-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		fs.mkdirSync(testDir, { recursive: true });
		engine = DeclarativeHooksEngine.getInstance();
		engine.clear();
	});

	afterEach(() => {
		engine.clear();
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("matches tool aliases and patterns accurately", () => {
		expect(engine.matches("*", "bash")).toBe(true);
		expect(engine.matches("run_command", "bash")).toBe(true);
		expect(engine.matches("bash", "run_command")).toBe(true);
		expect(engine.matches("edit*", "edit_file")).toBe(true);
		expect(engine.matches("edit", "edit_file")).toBe(true);
		expect(engine.matches("custom_tool", "bash")).toBe(false);
	});

	it("blocks PreToolUse when hook returns non-zero exit code", async () => {
		engine.registerHook("strict-security", {
			PreToolUse: [
				{
					matcher: "bash",
					hooks: [
						{
							command: "echo 'Dangerous operation detected' >&2; exit 2",
						},
					],
				},
			],
		});

		const gate = await engine.executePreToolUse("bash", { command: "curl http://bad.com" }, testDir);
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain("Dangerous operation detected");
	});

	it("permits PreToolUse when hook exits cleanly (0)", async () => {
		engine.registerHook("harmless-audit", {
			PreToolUse: [
				{
					matcher: "bash",
					hooks: [
						{
							command: "echo 'audit ok' && exit 0",
						},
					],
				},
			],
		});

		const gate = await engine.executePreToolUse("bash", { command: "echo ok" }, testDir);
		expect(gate.allowed).toBe(true);
	});

	it("loads hooks from workspace .agents/hooks.json", async () => {
		const agentsDir = path.join(testDir, ".agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		const hooksJson: HooksJsonFile = {
			"workspace-guard": {
				PreToolUse: [
					{
						matcher: "bash",
						hooks: [
							{
								command: "exit 0",
							},
						],
					},
				],
			},
		};

		fs.writeFileSync(path.join(agentsDir, "hooks.json"), JSON.stringify(hooksJson));
		const loaded = await engine.loadFromWorkspace(testDir);
		expect(loaded.length).toBeGreaterThan(0);
	});

	it("intercepts executeBash when PreToolUse hook blocks command", async () => {
		engine.registerHook("bash-blocker", {
			PreToolUse: [
				{
					matcher: "bash",
					hooks: [
						{
							command: "echo 'BLOCKED_BY_HOOK' >&2; exit 1",
						},
					],
				},
			],
		});

		const res = await executeBash("echo 'should not run'", { cwd: testDir, skipPolicyGuardian: true });
		expect(res.exitCode).toBe(1);
		expect(res.output).toContain("BLOCKED_BY_HOOK");
	});

	it("passes lastUserInput into hook environment and stdin JSON (agy 1.4.7 parity)", async () => {
		engine.registerHook("prompt-screen", {
			PreToolUse: [
				{
					matcher: "bash",
					hooks: [
						{
							command: `if [ "$AERY_LAST_USER_INPUT" = "forbidden-prompt" ]; then echo "BLOCKED_PROMPT" >&2; exit 3; fi`,
						},
					],
				},
			],
		});

		const blocked = await engine.executePreToolUse("bash", { command: "echo test" }, testDir, "forbidden-prompt");
		expect(blocked.allowed).toBe(false);
		expect(blocked.reason).toContain("BLOCKED_PROMPT");

		const allowed = await engine.executePreToolUse("bash", { command: "echo test" }, testDir, "harmless-prompt");
		expect(allowed.allowed).toBe(true);
	});
});
