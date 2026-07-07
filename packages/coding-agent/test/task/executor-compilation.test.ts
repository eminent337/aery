import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@aryee337/aery-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ text, options, promptIndex, emit, state });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}

function buildSuccessSession(): AgentSession {
	return createMockSession(({ emit, state }) => {
		const assistant = createAssistantStopMessage("some text");
		state.messages.push(assistant);
		emit({ type: "message_end", message: assistant });
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
	});
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess compilation check", () => {
	let tempDir: string;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	});
	it("runs validation check when tsconfig.json is present and fails if tsc exits non-zero", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-tsc-"));
		await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");

		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		// Spy and mock Bun.spawn to simulate tsc failing
		const mockSpawn = vi.spyOn(Bun, "spawn").mockImplementation((args: any) => {
			if (args[0] === "bunx" && args[1] === "tsc") {
				return {
					stdout: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("Type error in file.ts\n"));
							controller.close();
						},
					}),
					stderr: new ReadableStream({
						start(controller) {
							controller.close();
						},
					}),
					exited: Promise.resolve(1),
					exitCode: 1,
				} as any;
			}
			return { exited: Promise.resolve(0), exitCode: 0 } as any;
		});

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "compile test",
			index: 0,
			id: "subagent-compile",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			subagentCompileCheck: true,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("TypeScript compilation check failed:");
		expect(result.stderr).toContain("Type error in file.ts");
		expect(mockSpawn).toHaveBeenCalled();
	});

	it("runs validation check when Cargo.toml is present and fails if cargo check exits non-zero", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-cargo-"));
		await fs.writeFile(path.join(tempDir, "Cargo.toml"), "");

		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		// Spy and mock Bun.spawn to simulate cargo check failing
		const mockSpawn = vi.spyOn(Bun, "spawn").mockImplementation((args: any) => {
			if (args[0] === "cargo" && args[1] === "check") {
				return {
					stdout: new ReadableStream({
						start(controller) {
							controller.close();
						},
					}),
					stderr: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("cargo compilation error\n"));
							controller.close();
						},
					}),
					exited: Promise.resolve(101),
					exitCode: 101,
				} as any;
			}
			return { exited: Promise.resolve(0), exitCode: 0 } as any;
		});

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "cargo test",
			index: 0,
			id: "subagent-cargo",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			subagentCompileCheck: true,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Cargo check failed:");
		expect(result.stderr).toContain("cargo compilation error");
		expect(mockSpawn).toHaveBeenCalled();
	});

	it("succeeds if validation check passes", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-success-"));
		await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");

		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		const mockSpawn = vi.spyOn(Bun, "spawn").mockImplementation((args: any) => {
			return {
				stdout: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: Promise.resolve(0),
				exitCode: 0,
			} as any;
		});

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "compile test success",
			index: 0,
			id: "subagent-success",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			subagentCompileCheck: true,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(mockSpawn).toHaveBeenCalled();
	});
});

describe("runSubprocess compilation check — gating & safety", () => {
	let tempDir: string;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("skips the compile check when subagentCompileCheck is not enabled (default off)", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-off-"));
		await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");

		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		const mockSpawn = vi.spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({ start: c => c.close() }),
			stderr: new ReadableStream({ start: c => c.close() }),
			exited: Promise.resolve(1),
			exitCode: 1,
		} as any);

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "compile test off",
			index: 0,
			id: "subagent-off",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			// subagentCompileCheck omitted -> defaults to off
		});

		expect(result.exitCode).toBe(0);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("skips the compile check when no tsconfig.json/Cargo.toml is present", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-nocfg-"));
		// No config files at all.
		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		const mockSpawn = vi.spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({ start: c => c.close() }),
			stderr: new ReadableStream({ start: c => c.close() }),
			exited: Promise.resolve(1),
			exitCode: 1,
		} as any);

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "compile test nocfg",
			index: 0,
			id: "subagent-nocfg",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			subagentCompileCheck: true,
		});

		expect(result.exitCode).toBe(0);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("preserves rawOutput on a failed compile check", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-raw-"));
		await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");

		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		vi.spyOn(Bun, "spawn").mockImplementation((args: any) => {
			if (args[0] === "bunx" && args[1] === "tsc") {
				return {
					stdout: new ReadableStream({ start: c => c.close() }),
					stderr: new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode("type error"));
							c.close();
						},
					}),
					exited: Promise.resolve(1),
					exitCode: 1,
				} as any;
			}
			return { exited: Promise.resolve(0), exitCode: 0 } as any;
		});

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "compile test raw",
			index: 0,
			id: "subagent-raw",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			subagentCompileCheck: true,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("type error");
	});

	it("does not mask success when the compiler cannot be spawned", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-compile-throw-"));
		await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");

		const session = buildSuccessSession();
		mockCreateAgentSession(session);

		// Simulate the compiler binary being entirely absent.
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("command not found: bunx");
		});

		const result = await runSubprocess({
			cwd: tempDir,
			agent: baseAgent,
			task: "compile test throw",
			index: 0,
			id: "subagent-throw",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			subagentCompileCheck: true,
		});

		// The check could not run, so the successful agent result stands.
		expect(result.exitCode).toBe(0);
	});
});
