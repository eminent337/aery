# Universal External Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Universal External Agent Bridge in Aery to auto-discover all installed AI coding agents on the host machine (`agy`, `codex`, `opencode`, `claude`, `aider`, `pi`, `gh`, etc.) and expose a first-class tool `call_external_agent` supporting synchronous and background execution.

**Architecture:** A modular adapter system in `packages/coding-agent/src/extensibility/external-agents/` with dynamic PATH detection, argument builders for standard agents, universal custom fallback, and a dedicated `call_external_agent` tool integrated with Aery's tool registry and `AsyncJobManager`.

**Tech Stack:** TypeScript, Bun, Node child_process, `@aryee337/aery-coding-agent`, Vitest.

---

### Task 1: Core Types and Adapters for External Agents

**Files:**
- Create: `packages/coding-agent/src/extensibility/external-agents/types.ts`
- Create: `packages/coding-agent/src/extensibility/external-agents/adapters.ts`
- Test: `packages/coding-agent/test/external-agents-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/external-agents-adapters.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import {
	BUILTIN_EXTERNAL_AGENTS,
	getExternalAgentAdapter,
	listSupportedExternalAgents,
	resolveAgentInvocation,
} from "../src/extensibility/external-agents/adapters";

describe("External Agent Adapters", () => {
	it("registers all standard external agent adapters", () => {
		const supported = listSupportedExternalAgents();
		const ids = supported.map(a => a.id);
		expect(ids).toContain("agy");
		expect(ids).toContain("codex");
		expect(ids).toContain("opencode");
		expect(ids).toContain("claude");
		expect(ids).toContain("aider");
		expect(ids).toContain("pi");
		expect(ids).toContain("gh");
		expect(ids).toContain("custom");
	});

	it("formats agy non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("agy", "refactor test function");
		expect(invocation.binary).toBe("agy");
		expect(invocation.args).toEqual(["-p", "refactor test function", "--dangerously-skip-permissions"]);
	});

	it("formats codex non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("codex", "write unit tests");
		expect(invocation.binary).toBe("codex");
		expect(invocation.args).toEqual(["exec", "write unit tests", "--dangerously-bypass-approvals-and-sandbox"]);
	});

	it("formats opencode non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("opencode", "fix build error");
		expect(invocation.binary).toBe("opencode");
		expect(invocation.args).toEqual(["run", "fix build error", "--auto"]);
	});

	it("formats claude non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("claude", "lint codebase");
		expect(invocation.binary).toBe("claude");
		expect(invocation.args).toEqual(["-p", "lint codebase", "--dangerously-skip-permissions"]);
	});

	it("formats aider non-interactive execution arguments", () => {
		const invocation = resolveAgentInvocation("aider", "add readme file");
		expect(invocation.binary).toBe("aider");
		expect(invocation.args).toEqual(["--message", "add readme file", "--yes"]);
	});

	it("supports custom agent with explicit binary and extraArgs", () => {
		const invocation = resolveAgentInvocation("custom", "run inspection", {
			customBinary: "/opt/bin/my-agent",
			extraArgs: ["--flag1", "--flag2"],
		});
		expect(invocation.binary).toBe("/opt/bin/my-agent");
		expect(invocation.args).toEqual(["--flag1", "--flag2", "run inspection"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/external-agents-adapters.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

Create `packages/coding-agent/src/extensibility/external-agents/types.ts`:
```typescript
/**
 * Types for Universal External Agent Bridge
 */

export interface ExternalAgentExecutionOptions {
	cwd?: string;
	background?: boolean;
	extraArgs?: string[];
	customBinary?: string;
	timeoutMs?: number;
}

export interface ResolvedAgentInvocation {
	binary: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface ExternalAgentAdapter {
	id: string;
	displayName: string;
	defaultBinary: string;
	versionArgs: string[];
	buildArgs: (prompt: string, options?: ExternalAgentExecutionOptions) => string[];
	parseVersion?: (stdout: string) => string;
}

export interface DiscoveredExternalAgent {
	id: string;
	displayName: string;
	binaryPath: string;
	installed: boolean;
	version?: string;
}
```

Create `packages/coding-agent/src/extensibility/external-agents/adapters.ts`:
```typescript
import type {
	ExternalAgentAdapter,
	ExternalAgentExecutionOptions,
	ResolvedAgentInvocation,
} from "./types";

export const BUILTIN_EXTERNAL_AGENTS: Record<string, ExternalAgentAdapter> = {
	agy: {
		id: "agy",
		displayName: "Google Antigravity (agy)",
		defaultBinary: "agy",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["-p", prompt, "--dangerously-skip-permissions"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	codex: {
		id: "codex",
		displayName: "OpenAI Codex CLI",
		defaultBinary: "codex",
		versionArgs: ["-V"],
		buildArgs: (prompt, options) => {
			const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	opencode: {
		id: "opencode",
		displayName: "OpenCode",
		defaultBinary: "opencode",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["run", prompt, "--auto"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	claude: {
		id: "claude",
		displayName: "Anthropic Claude Code CLI",
		defaultBinary: "claude",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["-p", prompt, "--dangerously-skip-permissions"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	aider: {
		id: "aider",
		displayName: "Aider AI Pair Programmer",
		defaultBinary: "aider",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["--message", prompt, "--yes"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	pi: {
		id: "pi",
		displayName: "Pi Coding Agent",
		defaultBinary: "pi",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["-p", prompt];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	gh: {
		id: "gh",
		displayName: "GitHub Copilot CLI",
		defaultBinary: "gh",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["copilot", "suggest", prompt];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	custom: {
		id: "custom",
		displayName: "Custom / Generic CLI Agent",
		defaultBinary: "agent",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = options?.extraArgs ? [...options.extraArgs] : [];
			args.push(prompt);
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},
};

export function getExternalAgentAdapter(agentId: string): ExternalAgentAdapter | undefined {
	return BUILTIN_EXTERNAL_AGENTS[agentId.toLowerCase()];
}

export function listSupportedExternalAgents(): ExternalAgentAdapter[] {
	return Object.values(BUILTIN_EXTERNAL_AGENTS);
}

export function resolveAgentInvocation(
	agentId: string,
	prompt: string,
	options?: ExternalAgentExecutionOptions,
): ResolvedAgentInvocation {
	const adapter = getExternalAgentAdapter(agentId);
	if (!adapter) {
		throw new Error(
			`Unknown external agent '${agentId}'. Supported: ${listSupportedExternalAgents().map(a => a.id).join(", ")}`,
		);
	}

	const binary = options?.customBinary || adapter.defaultBinary;
	const args = adapter.buildArgs(prompt, options);

	return {
		binary,
		args,
		cwd: options?.cwd,
		timeoutMs: options?.timeoutMs,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/external-agents-adapters.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/extensibility/external-agents/ packages/coding-agent/test/external-agents-adapters.test.ts
git commit -m "feat(external-agents): add core types and adapters for external agent CLIs"
```

---

### Task 2: Dynamic Host Discovery and Version Probing

**Files:**
- Create: `packages/coding-agent/src/extensibility/external-agents/discovery.ts`
- Test: `packages/coding-agent/test/external-agents-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/external-agents-discovery.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import {
	detectExternalAgents,
	findBinaryInPath,
} from "../src/extensibility/external-agents/discovery";

describe("External Agent Discovery", () => {
	it("detects system binaries present in PATH", async () => {
		// 'which' or 'sh' is guaranteed to exist on Linux
		const shPath = await findBinaryInPath("sh");
		expect(shPath).not.toBeNull();
		expect(shPath).toContain("/bin/sh");
	});

	it("returns null for non-existent binary", async () => {
		const fakePath = await findBinaryInPath("non_existent_binary_xyz_12345");
		expect(fakePath).toBeNull();
	});

	it("discovers installed host agents", async () => {
		const results = await detectExternalAgents();
		expect(Array.isArray(results.installed)).toBe(true);
		expect(Array.isArray(results.uninstalled)).toBe(true);

		// If agy or codex is installed on host, they should be present in installed list
		const ids = results.installed.map(a => a.id);
		// Verified on host: agy, codex, opencode are installed
		expect(ids).toContain("agy");
		expect(ids).toContain("codex");
		expect(ids).toContain("opencode");

		const agyAgent = results.installed.find(a => a.id === "agy");
		expect(agyAgent?.installed).toBe(true);
		expect(agyAgent?.binaryPath).toBeDefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/external-agents-discovery.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

Create `packages/coding-agent/src/extensibility/external-agents/discovery.ts`:
```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listSupportedExternalAgents } from "./adapters";
import type { DiscoveredExternalAgent } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Searches system PATH for the given binary name.
 */
export async function findBinaryInPath(binaryName: string): Promise<string | null> {
	if (path.isAbsolute(binaryName)) {
		try {
			await fs.access(binaryName, fs.constants.X_OK);
			return binaryName;
		} catch {
			return null;
		}
	}

	const pathEnv = process.env.PATH ?? "";
	const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

	for (const dir of pathDirs) {
		const fullPath = path.join(dir, binaryName);
		try {
			await fs.access(fullPath, fs.constants.X_OK);
			return fullPath;
		} catch {
			// Continue searching next directory
		}
	}

	return null;
}

export interface ExternalAgentDiscoveryResult {
	installed: DiscoveredExternalAgent[];
	uninstalled: Array<{ id: string; displayName: string; defaultBinary: string }>;
}

/**
 * Scans host system for all supported external AI coding agents.
 */
export async function detectExternalAgents(): Promise<ExternalAgentDiscoveryResult> {
	const adapters = listSupportedExternalAgents().filter(a => a.id !== "custom");
	const installed: DiscoveredExternalAgent[] = [];
	const uninstalled: Array<{ id: string; displayName: string; defaultBinary: string }> = [];

	await Promise.all(
		adapters.map(async adapter => {
			const binaryPath = await findBinaryInPath(adapter.defaultBinary);
			if (binaryPath) {
				let version: string | undefined;
				try {
					const { stdout } = await execFileAsync(binaryPath, adapter.versionArgs, { timeout: 3000 });
					version = adapter.parseVersion ? adapter.parseVersion(stdout) : stdout.trim();
				} catch {
					version = undefined;
				}

				installed.push({
					id: adapter.id,
					displayName: adapter.displayName,
					binaryPath,
					installed: true,
					version,
				});
			} else {
				uninstalled.push({
					id: adapter.id,
					displayName: adapter.displayName,
					defaultBinary: adapter.defaultBinary,
				});
			}
		}),
	);

	// Sort installed agents alphabetically
	installed.sort((a, b) => a.id.localeCompare(b.id));
	uninstalled.sort((a, b) => a.id.localeCompare(b.id));

	return { installed, uninstalled };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/external-agents-discovery.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/extensibility/external-agents/discovery.ts packages/coding-agent/test/external-agents-discovery.test.ts
git commit -m "feat(external-agents): add dynamic host PATH discovery and version probing"
```

---

### Task 3: Execution Engine (Sync & Async/Background Runner)

**Files:**
- Create: `packages/coding-agent/src/extensibility/external-agents/runner.ts`
- Test: `packages/coding-agent/test/external-agents-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/external-agents-runner.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { executeExternalAgent } from "../src/extensibility/external-agents/runner";

describe("External Agent Runner", () => {
	it("executes a command synchronously and captures stdout", async () => {
		const result = await executeExternalAgent({
			agentId: "custom",
			prompt: "hello from test",
			options: {
				customBinary: "echo",
				background: false,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello from test");
		expect(result.timedOut).toBe(false);
	});

	it("handles non-zero exit codes gracefully without crashing", async () => {
		const result = await executeExternalAgent({
			agentId: "custom",
			prompt: "exiting 42",
			options: {
				customBinary: "bash",
				extraArgs: ["-c", "exit 42 #"],
				background: false,
			},
		});

		expect(result.exitCode).toBe(42);
	});

	it("respects timeouts", async () => {
		const result = await executeExternalAgent({
			agentId: "custom",
			prompt: "sleep",
			options: {
				customBinary: "sleep",
				extraArgs: ["2"],
				timeoutMs: 100,
				background: false,
			},
		});

		expect(result.timedOut).toBe(true);
		expect(result.error).toContain("timed out");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/external-agents-runner.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

Create `packages/coding-agent/src/extensibility/external-agents/runner.ts`:
```typescript
import { spawn } from "node:child_process";
import { AsyncJobManager } from "../../async";
import { resolveAgentInvocation } from "./adapters";
import { findBinaryInPath } from "./discovery";
import type { ExternalAgentExecutionOptions } from "./types";

export interface ExternalAgentExecutionParams {
	agentId: string;
	prompt: string;
	options?: ExternalAgentExecutionOptions;
	signal?: AbortSignal;
}

export interface ExternalAgentExecutionResult {
	agent: string;
	binary: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	error?: string;
	backgroundJob?: {
		jobId: string;
		status: "running";
		message: string;
	};
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function executeExternalAgent(
	params: ExternalAgentExecutionParams,
): Promise<ExternalAgentExecutionResult> {
	const { agentId, prompt, options, signal } = params;
	const invocation = resolveAgentInvocation(agentId, prompt, options);

	const resolvedBinaryPath = await findBinaryInPath(invocation.binary);
	if (!resolvedBinaryPath) {
		throw new Error(
			`External agent binary '${invocation.binary}' not found in PATH or not executable. Use 'call_external_agent' with agent: 'list' to see available agents.`,
		);
	}

	const cwd = invocation.cwd ?? process.cwd();
	const timeoutMs = invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Background execution path
	if (options?.background) {
		const manager = AsyncJobManager.instance();
		if (manager) {
			let jobOutput = "";
			const jobId = manager.register(
				"task",
				`external-agent:${agentId}`,
				async ({ signal: jobSignal, onProgress }) => {
					await new Promise<void>((resolve, reject) => {
						const child = spawn(resolvedBinaryPath, invocation.args, {
							cwd,
							env: process.env,
							stdio: ["ignore", "pipe", "pipe"],
						});

						const onAbort = () => {
							child.kill("SIGTERM");
						};
						jobSignal.addEventListener("abort", onAbort, { once: true });

						child.stdout?.on("data", chunk => {
							const text = chunk.toString();
							jobOutput += text;
							if (onProgress) void onProgress(text);
						});

						child.stderr?.on("data", chunk => {
							const text = chunk.toString();
							jobOutput += text;
							if (onProgress) void onProgress(text);
						});

						child.on("close", code => {
							jobSignal.removeEventListener("abort", onAbort);
							if (code === 0) resolve();
							else reject(new Error(`Agent exited with code ${code}`));
						});

						child.on("error", err => {
							jobSignal.removeEventListener("abort", onAbort);
							reject(err);
						});
					});
				},
			);

			return {
				agent: agentId,
				binary: resolvedBinaryPath,
				exitCode: null,
				stdout: "",
				stderr: "",
				durationMs: 0,
				timedOut: false,
				backgroundJob: {
					jobId,
					status: "running",
					message: `Task successfully dispatched to '${agentId}' in the background. Use manage_task to inspect progress.`,
				},
			};
		}
	}

	// Synchronous execution path
	const startTime = Date.now();
	return new Promise<ExternalAgentExecutionResult>(resolve => {
		let timedOut = false;
		let stdout = "";
		let stderr = "";

		const child = spawn(resolvedBinaryPath, invocation.args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
		};

		if (signal) {
			if (signal.aborted) {
				clearTimeout(timeoutTimer);
				child.kill("SIGKILL");
				return resolve({
					agent: agentId,
					binary: resolvedBinaryPath,
					exitCode: null,
					stdout: "",
					stderr: "Aborted before start",
					durationMs: 0,
					timedOut: false,
					error: "Aborted before start",
				});
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", chunk => {
			stdout += chunk.toString();
		});

		child.stderr?.on("data", chunk => {
			stderr += chunk.toString();
		});

		child.on("close", code => {
			clearTimeout(timeoutTimer);
			if (signal) signal.removeEventListener("abort", onAbort);

			const durationMs = Date.now() - startTime;
			resolve({
				agent: agentId,
				binary: resolvedBinaryPath,
				exitCode: code,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				durationMs,
				timedOut,
				error: timedOut ? `Execution timed out after ${timeoutMs}ms` : undefined,
			});
		});

		child.on("error", err => {
			clearTimeout(timeoutTimer);
			if (signal) signal.removeEventListener("abort", onAbort);

			const durationMs = Date.now() - startTime;
			resolve({
				agent: agentId,
				binary: resolvedBinaryPath,
				exitCode: null,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				durationMs,
				timedOut,
				error: err.message,
			});
		});
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/external-agents-runner.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/extensibility/external-agents/runner.ts packages/coding-agent/test/external-agents-runner.test.ts
git commit -m "feat(external-agents): add sync and async/background execution engine"
```

---

### Task 4: `call_external_agent` Tool & Registry Integration

**Files:**
- Create: `packages/coding-agent/src/tools/external-agent.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Test: `packages/coding-agent/test/call-external-agent-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/coding-agent/test/call-external-agent-tool.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { CallExternalAgentTool } from "../src/tools/external-agent";

describe("CallExternalAgentTool", () => {
	const tool = new CallExternalAgentTool({ cwd: process.cwd() } as any);

	it("has proper metadata and schema", () => {
		expect(tool.name).toBe("call_external_agent");
		expect(tool.parameters).toBeDefined();
	});

	it("lists available agents when agent is 'list'", async () => {
		const result = await tool.execute("call-1", { agent: "list" });
		expect(result.content).toBeDefined();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Installed External Agents");
		expect(text).toContain("agy");
	});

	it("executes custom agent tool call", async () => {
		const result = await tool.execute("call-2", {
			agent: "custom",
			prompt: "hello tool",
			customBinary: "echo",
		});
		expect(result.content).toBeDefined();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("hello tool");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/call-external-agent-tool.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

Create `packages/coding-agent/src/tools/external-agent.ts`:
```typescript
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { detectExternalAgents } from "../extensibility/external-agents/discovery";
import { executeExternalAgent } from "../extensibility/external-agents/runner";
import type { ToolSession } from "./index";

const callExternalAgentSchema = z.object({
	agent: z
		.string()
		.describe(
			"The external agent to invoke ('agy', 'codex', 'opencode', 'claude', 'aider', 'pi', 'custom') or 'list' to inspect available agents on the host machine.",
		),
	prompt: z
		.string()
		.optional()
		.describe("The task instructions or prompt to deliver to the external agent."),
	cwd: z
		.string()
		.optional()
		.describe("Working directory for the agent execution. Defaults to current workspace directory."),
	background: z
		.boolean()
		.optional()
		.describe("If true, dispatches the task as a background job and returns immediately with a jobId."),
	extraArgs: z
		.array(z.string())
		.optional()
		.describe("Optional extra CLI arguments or flags to pass to the agent."),
	customBinary: z
		.string()
		.optional()
		.describe("Required when agent is 'custom' or to specify an exact absolute path to the binary."),
	timeoutMs: z
		.number()
		.optional()
		.describe("Optional timeout in milliseconds (default: 300000 / 5 minutes)."),
});

export type CallExternalAgentParams = z.infer<typeof callExternalAgentSchema>;

export class CallExternalAgentTool implements AgentTool<typeof callExternalAgentSchema> {
	readonly name = "call_external_agent";
	readonly approval = "exec" as const;
	readonly label = "External Agent";
	readonly summary = "Call an external AI coding agent installed on the machine (agy, codex, opencode, etc.)";
	readonly description =
		"Execute a task using an external AI coding agent installed on this machine (e.g. agy, codex, opencode, claude, aider) or query available installed agents with agent: 'list'.";
	readonly parameters = callExternalAgentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(
		toolCallId: string,
		params: CallExternalAgentParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<any>> {
		// Listing mode
		if (params.agent.toLowerCase() === "list") {
			const discovery = await detectExternalAgents();
			const installedLines = discovery.installed.map(
				a => `  - **${a.id}** (${a.displayName}): \`${a.binaryPath}\`${a.version ? ` [${a.version}]` : ""}`,
			);
			const uninstalledLines = discovery.uninstalled.map(
				a => `  - **${a.id}** (${a.displayName}) [not found in PATH]`,
			);

			const output = [
				"### Installed External Agents",
				installedLines.length > 0 ? installedLines.join("\n") : "  (none found)",
				"",
				"### Uninstalled / Not in PATH",
				uninstalledLines.length > 0 ? uninstalledLines.join("\n") : "  (none)",
			].join("\n");

			return {
				content: [{ type: "text", text: output }],
				details: discovery,
			};
		}

		if (!params.prompt) {
			return {
				content: [
					{
						type: "text",
						text: "Error: 'prompt' parameter is required when calling an external agent. (To check available agents, use agent: 'list').",
					},
				],
			};
		}

		try {
			const result = await executeExternalAgent({
				agentId: params.agent,
				prompt: params.prompt,
				options: {
					cwd: params.cwd ?? this.session.cwd,
					background: params.background,
					extraArgs: params.extraArgs,
					customBinary: params.customBinary,
					timeoutMs: params.timeoutMs,
				},
				signal,
			});

			if (result.backgroundJob) {
				return {
					content: [
						{
							type: "text",
							text: `Dispatched background job for agent '${params.agent}' (Job ID: ${result.backgroundJob.jobId}).\n${result.backgroundJob.message}`,
						},
					],
					details: result,
				};
			}

			const formattedOutput = [
				`### External Agent Execution: ${result.agent}`,
				`**Exit Code**: ${result.exitCode ?? "N/A"}${result.timedOut ? " (TIMED OUT)" : ""}`,
				`**Duration**: ${(result.durationMs / 1000).toFixed(2)}s`,
				"",
				result.stdout ? `#### Output:\n\`\`\`\n${result.stdout}\n\`\`\`` : "",
				result.stderr ? `#### Errors:\n\`\`\`\n${result.stderr}\n\`\`\`` : "",
				result.error ? `**Error**: ${result.error}` : "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: formattedOutput }],
				details: result,
			};
		} catch (error: any) {
			return {
				content: [{ type: "text", text: `External Agent Error: ${error?.message ?? String(error)}` }],
			};
		}
	}
}
```

In `packages/coding-agent/src/tools/index.ts`:
Add import:
```typescript
import { CallExternalAgentTool } from "./external-agent";
```
Register in `BUILTIN_TOOLS`:
```typescript
call_external_agent: s => new CallExternalAgentTool(s),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/call-external-agent-tool.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/tools/external-agent.ts packages/coding-agent/src/tools/index.ts packages/coding-agent/test/call-external-agent-tool.test.ts
git commit -m "feat(tools): add call_external_agent tool for invoking host AI agents"
```

---

### Task 5: End-to-End Verification, Type Checking & Push

**Files:**
- Modify: (None, verification only)

- [ ] **Step 1: Run complete external agents test suite**

Run: `bun test packages/coding-agent/test/external-agents-*.test.ts packages/coding-agent/test/call-external-agent-tool.test.ts`  
Expected: All tests pass (100%).

- [ ] **Step 2: Run type check**

Run: `cd packages/coding-agent && bun run check:types`  
Expected: Zero TypeScript errors.

- [ ] **Step 3: Push to GitHub repository**

Run: `git push origin main`  
Expected: Successfully pushed to `origin/main`.
