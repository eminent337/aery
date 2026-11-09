import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSubagentDefinition, listBuiltinSubagents } from "../../src/registry/builtin-subagents";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SubagentRunner } from "../../src/registry/subagent-runner";
import { OpencodeSubagentSession } from "../../src/acp/subagent-session";
import { AcpClient } from "../../src/acp/client";
import type { AcpTransport, JsonRpcNotification, JsonRpcRequest } from "../../src/acp/types";

class MockAcpTransport {
	public requests: JsonRpcRequest[] = [];
	public notifications: JsonRpcNotification[] = [];
	private closed = false;
	private notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();

	get isClosed(): boolean {
		return this.closed;
	}

	isClosedFn(): boolean {
		return this.closed;
	}

	async request<T = any>(method: string, params?: any): Promise<T> {
		this.requests.push({ jsonrpc: "2.0", id: this.requests.length + 1, method, params });

		if (method === "initialize") {
			return {
				protocolVersion: 1,
				capabilities: { streaming: true },
				serverInfo: { name: "opencode-acp-mock", version: "1.0.0" },
			} as T;
		}

		if (method === "session/new") {
			return { sessionId: "sess-opencode-123" } as T;
		}

		if (method === "session/prompt") {
			for (const handler of Array.from(this.notificationHandlers)) {
				handler({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: params.sessionId,
						updateType: "tool_call",
						toolCall: {
							toolName: "read_file",
							toolArgs: { path: "src/index.ts" },
						},
					},
				});
				handler({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: params.sessionId,
						updateType: "chunk",
						content: "Analyzed src/index.ts and completed task.",
					},
				});
				handler({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: params.sessionId,
						updateType: "tool_result",
						toolCall: {
							toolName: "read_file",
						},
						content: "file contents",
					},
				});
			}

			return {
				stopReason: "end_turn",
			} as T;
		}

		if (method === "session/cancel") {
			return { cancelled: true } as T;
		}

		throw new Error(`Unhandled mock method: ${method}`);
	}

	notify(method: string, params?: any): void {
		this.notifications.push({ jsonrpc: "2.0", method, params });
	}

	onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	close(): void {
		this.closed = true;
	}
}

describe("OpenCode Subagent Swarm Integration", () => {
	describe("Builtin Subagent Registration", () => {
		it("registers opencode subagent with expected properties", () => {
			const def = getSubagentDefinition("opencode");
			expect(def).toBeDefined();
			expect(def?.typeName).toBe("opencode");
			expect(def?.role).toBe("OpenCode ACP Worker");
			expect(def?.tools).toEqual(["*"]);
			expect(def?.description).toContain("OpenCode");

			const all = listBuiltinSubagents();
			const hasOpencode = all.some((a) => a.typeName === "opencode");
			expect(hasOpencode).toBe(true);
		});
	});

	describe("OpencodeSubagentSession", () => {
		it("initializes ACP client, runs prompt, and emits lifecycle events", async () => {
			const tmpDir = path.join(os.tmpdir(), `aery-subagent-test-${Date.now()}`);
			fs.mkdirSync(tmpDir, { recursive: true });
			const logPath = path.join(tmpDir, "session.jsonl");

			try {
				const transport = new MockAcpTransport();
				const client = new AcpClient({ transport });

				const events: any[] = [];
				const session = new OpencodeSubagentSession({
					conversationId: "sub-opencode-1",
					cwd: tmpDir,
					logPath,
					client,
				});

				session.subscribe((ev) => events.push(ev));

				await session.prompt("Inspect the project and build");

				expect(session.getLastAssistantText()).toBe("Analyzed src/index.ts and completed task.");

				const eventTypes = events.map((e) => e.type);
				expect(eventTypes).toContain("turn_start");
				expect(eventTypes).toContain("tool_execution_start");
				expect(eventTypes).toContain("tool_execution_end");
				expect(eventTypes).toContain("turn_end");
				expect(eventTypes).toContain("agent_end");

				const deltaEvent = events.find((e) => e.type === "message_delta");
				expect(deltaEvent).toBeDefined();
				expect(deltaEvent.chunk).toBe("Analyzed src/index.ts and completed task.");

				const toolEndEvent = events.find((e) => e.type === "tool_execution_end");
				expect(toolEndEvent).toBeDefined();
				expect(toolEndEvent.result).toBe("file contents");

				expect(fs.existsSync(logPath)).toBe(true);
				const logContent = fs.readFileSync(logPath, "utf-8");
				expect(logContent).toContain("USER_INPUT");
				expect(logContent).toContain("PLANNER_RESPONSE");

				await session.dispose();
				expect(transport.isClosed).toBe(true);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("serializes concurrent prompts cleanly without interleaving", async () => {
			const transport = new MockAcpTransport();
			const client = new AcpClient({ transport });

			const session = new OpencodeSubagentSession({
				conversationId: "sub-opencode-concurrent",
				cwd: os.tmpdir(),
				client,
			});

			const p1 = session.prompt("First instruction");
			const p2 = session.prompt("Second instruction");
			await Promise.all([p1, p2]);

			const promptRequests = transport.requests.filter((r) => r.method === "session/prompt");
			expect(promptRequests.length).toBe(2);

			await session.dispose();
			expect(transport.isClosed).toBe(true);
		});

		it("handles dispose while prompt is in-flight cleanly", async () => {
			const transport = new MockAcpTransport();
			const client = new AcpClient({ transport });

			const session = new OpencodeSubagentSession({
				conversationId: "sub-opencode-inflight-dispose",
				cwd: os.tmpdir(),
				client,
			});

			const inFlight = session.prompt("Long running work");
			await session.dispose();
			await inFlight.catch(() => {});

			expect(transport.isClosed).toBe(true);
		});

		it("supports cancellation and abort", async () => {
			const transport = new MockAcpTransport();
			const client = new AcpClient({ transport });

			const session = new OpencodeSubagentSession({
				conversationId: "sub-opencode-abort",
				cwd: os.tmpdir(),
				client,
			});

			await session.abort();
			await session.dispose();
			expect(transport.isClosed).toBe(true);
		});
	});

	describe("SubagentRunner with opencode type", () => {
		it("spawns opencode subagent, tracks in AgentRegistry, and notifies parent", async () => {
			const registry = new AgentRegistry();
			const parentMessages: any[] = [];
			const mockParentSession = {
				sendCustomMessage: async (msg: any) => {
					parentMessages.push(msg);
				},
			};

			registry.register({
				id: "Main",
				displayName: "Main Agent",
				kind: "main",
				session: mockParentSession as any,
				status: "idle",
			});

			const transport = new MockAcpTransport();
			const client = new AcpClient({ transport });

			const runner = new SubagentRunner(registry);
			const launchResult = await runner.launch({
				typeName: "opencode",
				role: "Test Worker",
				prompt: "Refactor database models",
				parentId: "Main",
				acpClient: client,
			});

			expect(launchResult.conversationId).toMatch(/^sub-test-worker-/);
			expect(launchResult.resolvedModel).toBe("opencode-acp");

			const agentRef = registry.get(launchResult.conversationId);
			expect(agentRef).toBeDefined();

			let attempts = 0;
			while (parentMessages.length === 0 && attempts < 20) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				attempts++;
			}

			expect(parentMessages.length).toBeGreaterThan(0);
			const msg = parentMessages[0];
			expect(msg.content).toContain("Subagent completed execution");
			expect(msg.content).toContain("Analyzed src/index.ts and completed task.");
		});
	});
});