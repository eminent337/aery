/**
 * Declarative Hooks Engine (`hooks.json`).
 *
 * Implements the Google Antigravity hooks specification, enabling teams to enforce
 * pre-tool validation, post-tool linting, session initialization, and lifecycle monitoring.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	DeclarativeHookDef,
	HookExecResult,
	HookHandlerConfig,
	HooksJsonFile,
	PostToolGateResult,
	PreToolGateResult,
} from "./types";

export class DeclarativeHooksEngine {
	private static instance?: DeclarativeHooksEngine;
	private hookDefs = new Map<string, DeclarativeHookDef>();

	public static getInstance(): DeclarativeHooksEngine {
		if (!DeclarativeHooksEngine.instance) {
			DeclarativeHooksEngine.instance = new DeclarativeHooksEngine();
		}
		return DeclarativeHooksEngine.instance;
	}

	public clear(): void {
		this.hookDefs.clear();
	}

	/**
	 * Register an in-memory declarative hook definition.
	 */
	public registerHook(name: string, def: DeclarativeHookDef): void {
		if (def.enabled !== false) {
			this.hookDefs.set(name, def);
		}
	}

	/**
	 * Loads hooks from standard locations:
	 * 1. <workspace>/.agents/hooks.json
	 * 2. <workspace>/.aery/hooks.json
	 * 3. ~/.aery/hooks.json
	 * 4. ~/.gemini/config/hooks.json
	 */
	public async loadFromWorkspace(workspaceDir?: string): Promise<string[]> {
		const candidates: string[] = [
			path.join(os.homedir(), ".aery", "hooks.json"),
			path.join(os.homedir(), ".gemini", "config", "hooks.json"),
		];

		if (workspaceDir) {
			candidates.unshift(path.join(workspaceDir, ".agents", "hooks.json"));
			candidates.unshift(path.join(workspaceDir, ".aery", "hooks.json"));
		}

		const loadedFiles: string[] = [];

		for (const filePath of candidates) {
			if (fs.existsSync(filePath)) {
				try {
					const content = await fs.promises.readFile(filePath, "utf-8");
					const parsed = JSON.parse(content) as HooksJsonFile;
					for (const [name, def] of Object.entries(parsed)) {
						this.registerHook(name, def);
					}
					loadedFiles.push(filePath);
				} catch (err) {
					console.error(`Failed to load hooks.json at ${filePath}:`, err);
				}
			}
		}

		return loadedFiles;
	}

	/**
	 * Matches tool names against hook matcher patterns.
	 * Supports aliases like run_command <-> bash and edit_file <-> edit.
	 */
	public matches(matcher: string, toolName: string): boolean {
		if (!matcher || matcher === "*") return true;

		const targets = matcher
			.split(/[,|]/)
			.map(s => s.trim().toLowerCase())
			.filter(Boolean);

		const normalizedTool = toolName.toLowerCase();
		const equivalentNames = new Set<string>([normalizedTool]);

		if (normalizedTool === "run_command" || normalizedTool === "bash") {
			equivalentNames.add("run_command");
			equivalentNames.add("bash");
		}
		if (normalizedTool === "edit" || normalizedTool === "edit_file") {
			equivalentNames.add("edit");
			equivalentNames.add("edit_file");
		}

		for (const target of targets) {
			if (target === "*") return true;
			for (const eq of equivalentNames) {
				if (target === eq) return true;
				// Simple wildcard support e.g. "git*" or "edit*"
				if (target.includes("*")) {
					const regex = new RegExp(`^${target.replace(/\*/g, ".*")}$`, "i");
					if (regex.test(eq)) return true;
				}
			}
		}

		return false;
	}

	/**
	 * Executes SessionStart hooks.
	 */
	public async executeSessionStart(workspaceDir: string): Promise<void> {
		for (const def of this.hookDefs.values()) {
			if (def.enabled === false || !def.SessionStart) continue;
			for (const handler of def.SessionStart) {
				await this.runHandler(handler, workspaceDir, {
					AERY_EVENT: "SessionStart",
					AGY_EVENT: "SessionStart",
					AERY_WORKSPACE: workspaceDir,
					AGY_WORKSPACE: workspaceDir,
				});
			}
		}
	}

	/**
	 * Executes PreToolUse hooks. Non-zero exit code halts tool execution.
	 */
	public async executePreToolUse(
		toolName: string,
		toolParams: unknown,
		workspaceDir: string,
		lastUserInput?: string,
	): Promise<PreToolGateResult> {
		const inputJson = typeof toolParams === "string" ? toolParams : JSON.stringify(toolParams ?? {});
		const stdinPayload = JSON.stringify({
			tool: toolName,
			input: typeof toolParams === "string" ? toolParams : (toolParams ?? {}),
			lastUserInput: lastUserInput || "",
		});

		for (const [hookName, def] of this.hookDefs.entries()) {
			if (def.enabled === false || !def.PreToolUse) continue;

			for (const group of def.PreToolUse) {
				if (!this.matches(group.matcher, toolName)) continue;

				for (const handler of group.hooks) {
					const result = await this.runHandler(
						handler,
						workspaceDir,
						{
							AERY_EVENT: "PreToolUse",
							AGY_EVENT: "PreToolUse",
							AERY_TOOL_NAME: toolName,
							AGY_TOOL_NAME: toolName,
							AERY_TOOL_INPUT: inputJson,
							AGY_TOOL_INPUT: inputJson,
							AERY_LAST_USER_INPUT: lastUserInput || "",
							AGY_LAST_USER_INPUT: lastUserInput || "",
							AERY_WORKSPACE: workspaceDir,
							AGY_WORKSPACE: workspaceDir,
						},
						stdinPayload,
					);

					if (!result.success) {
						return {
							allowed: false,
							reason: `Hook '${hookName}' blocked tool '${toolName}': ${result.stderr.trim() || result.stdout.trim() || `Exit code ${result.exitCode}`}`,
							stdout: result.stdout,
							stderr: result.stderr,
						};
					}
				}
			}
		}

		return { allowed: true };
	}

	/**
	 * Executes PostToolUse hooks. Collects any output or warnings.
	 */
	public async executePostToolUse(
		toolName: string,
		toolParams: unknown,
		toolResult: unknown,
		workspaceDir: string,
		lastUserInput?: string,
	): Promise<PostToolGateResult> {
		const inputJson = typeof toolParams === "string" ? toolParams : JSON.stringify(toolParams ?? {});
		const outputText = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult ?? {});
		const stdinPayload = JSON.stringify({
			tool: toolName,
			input: typeof toolParams === "string" ? toolParams : (toolParams ?? {}),
			output: toolResult,
			lastUserInput: lastUserInput || "",
		});

		const warnings: string[] = [];

		for (const [hookName, def] of this.hookDefs.entries()) {
			if (def.enabled === false || !def.PostToolUse) continue;

			for (const group of def.PostToolUse) {
				if (!this.matches(group.matcher, toolName)) continue;

				for (const handler of group.hooks) {
					const result = await this.runHandler(
						handler,
						workspaceDir,
						{
							AERY_EVENT: "PostToolUse",
							AGY_EVENT: "PostToolUse",
							AERY_TOOL_NAME: toolName,
							AGY_TOOL_NAME: toolName,
							AERY_TOOL_INPUT: inputJson,
							AGY_TOOL_INPUT: inputJson,
							AERY_TOOL_OUTPUT: outputText,
							AGY_TOOL_OUTPUT: outputText,
							AERY_LAST_USER_INPUT: lastUserInput || "",
							AGY_LAST_USER_INPUT: lastUserInput || "",
							AERY_WORKSPACE: workspaceDir,
							AGY_WORKSPACE: workspaceDir,
						},
						stdinPayload,
					);

					if (!result.success && (result.stderr || result.stdout)) {
						warnings.push(
							`Hook '${hookName}' warning on '${toolName}': ${(result.stderr || result.stdout).trim()}`,
						);
					}
				}
			}
		}

		return { warnings };
	}

	/**
	 * Executes PreInvocation hooks.
	 */
	public async executePreInvocation(workspaceDir: string): Promise<void> {
		for (const def of this.hookDefs.values()) {
			if (def.enabled === false || !def.PreInvocation) continue;
			for (const handler of def.PreInvocation) {
				await this.runHandler(handler, workspaceDir, {
					AERY_EVENT: "PreInvocation",
					AGY_EVENT: "PreInvocation",
					AERY_WORKSPACE: workspaceDir,
				});
			}
		}
	}

	/**
	 * Executes PostInvocation hooks.
	 */
	public async executePostInvocation(workspaceDir: string): Promise<void> {
		for (const def of this.hookDefs.values()) {
			if (def.enabled === false || !def.PostInvocation) continue;
			for (const handler of def.PostInvocation) {
				await this.runHandler(handler, workspaceDir, {
					AERY_EVENT: "PostInvocation",
					AGY_EVENT: "PostInvocation",
					AERY_WORKSPACE: workspaceDir,
				});
			}
		}
	}

	/**
	 * Executes Stop hooks on session teardown.
	 */
	public async executeStop(workspaceDir: string): Promise<void> {
		for (const def of this.hookDefs.values()) {
			if (def.enabled === false || !def.Stop) continue;
			for (const handler of def.Stop) {
				await this.runHandler(handler, workspaceDir, {
					AERY_EVENT: "Stop",
					AGY_EVENT: "Stop",
					AERY_WORKSPACE: workspaceDir,
				});
			}
		}
	}

	private async runHandler(
		handler: HookHandlerConfig,
		cwd: string,
		envAdditions: Record<string, string>,
		stdinData?: string,
	): Promise<HookExecResult> {
		const timeoutMs = (handler.timeout ?? 15) * 1000;

		return new Promise<HookExecResult>(resolve => {
			const env = { ...process.env, ...envAdditions };
			let stdout = "";
			let stderr = "";

			const child = spawn("bash", ["-c", handler.command], {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve({
					success: false,
					stdout,
					stderr: `${stderr}\nHook timed out after ${handler.timeout ?? 15}s`,
					exitCode: 124,
				});
			}, timeoutMs);

			if (stdinData && child.stdin) {
				try {
					child.stdin.write(stdinData);
					child.stdin.end();
				} catch {}
			}

			child.stdout?.on("data", chunk => {
				stdout += chunk.toString();
			});

			child.stderr?.on("data", chunk => {
				stderr += chunk.toString();
			});

			child.on("close", code => {
				clearTimeout(timer);
				resolve({
					success: code === 0,
					stdout,
					stderr,
					exitCode: code ?? 1,
				});
			});

			child.on("error", err => {
				clearTimeout(timer);
				resolve({
					success: false,
					stdout,
					stderr: err.message,
					exitCode: 1,
				});
			});
		});
	}
}
