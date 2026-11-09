import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { AcpClient } from "../../src/acp/client";
import { AcpTransport } from "../../src/acp/transport";
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "../../src/acp/types";

describe("AcpClient", () => {
	describe("In-Memory Custom Transport", () => {
		let clientIn: PassThrough;
		let clientOut: PassThrough;
		let transport: AcpTransport;
		let client: AcpClient;

		// Mock server responder helper
		function handleNextRequest(handler: (req: JsonRpcRequest) => JsonRpcResponse | void) {
			const onData = (chunk: Buffer) => {
				const lines = chunk.toString("utf8").split("\n");
				for (const line of lines) {
					if (!line.trim()) continue;
					const parsed = JSON.parse(line) as JsonRpcRequest;
					if (parsed.id !== undefined) {
						clientOut.removeListener("data", onData);
						const res = handler(parsed);
						if (res) {
							clientIn.write(JSON.stringify(res) + "\n");
						}
						return;
					}
				}
			};
			clientOut.on("data", onData);
		}

		beforeEach(() => {
			clientIn = new PassThrough();
			clientOut = new PassThrough();
			transport = new AcpTransport(clientIn, clientOut);
			client = new AcpClient({
				command: "mock-agent",
				customTransport: transport,
			});
		});

		afterEach(async () => {
			await client.stop();
		});

		it("requires start() before calling session methods", async () => {
			expect(client.isAlive()).toBe(false);
			await expect(client.sessionNew("/tmp")).rejects.toThrow("AcpClient is not started");
		});

		it("starts and performs initialize handshake with protocolVersion 1", async () => {
			handleNextRequest((req) => {
				expect(req.method).toBe("initialize");
				expect(req.params.protocolVersion).toBe(1);
				expect(req.params.clientInfo).toEqual({ name: "aery", version: "0.14.0" });
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: {
						protocolVersion: 1,
						agentInfo: { name: "mock-agent", version: "1.0.0" },
					},
				};
			});

			const initResult = await client.start();
			expect(initResult.protocolVersion).toBe(1);
			expect(initResult.agentInfo?.name).toBe("mock-agent");
			expect(client.isAlive()).toBe(true);

			// Second start returns cached result without sending another initialize request
			const secondInit = await client.start();
			expect(secondInit).toBe(initResult);
		});

		it("creates a new session and returns sessionId", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			handleNextRequest((req) => {
				expect(req.method).toBe("session/new");
				expect(req.params.cwd).toBe("/workspace/project");
				expect(req.params.mcpServers).toEqual([{ name: "test-mcp" }]);
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: { sessionId: "sess-12345" },
				};
			});

			const sessionId = await client.sessionNew("/workspace/project", [{ name: "test-mcp" }]);
			expect(sessionId).toBe("sess-12345");
		});

		it("loads an existing session", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			handleNextRequest((req) => {
				expect(req.method).toBe("session/load");
				expect(req.params.sessionId).toBe("sess-existing");
				expect(req.params.cwd).toBe("/workspace/project");
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: { status: "loaded" },
				};
			});

			await client.sessionLoad("sess-existing", "/workspace/project");
		});

		it("cancels an active session", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			handleNextRequest((req) => {
				expect(req.method).toBe("session/cancel");
				expect(req.params.sessionId).toBe("sess-to-cancel");
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: { status: "cancelled" },
				};
			});

			await client.sessionCancel("sess-to-cancel");
		});

		it("streams prompt updates and aggregates full text and tool calls", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			const receivedUpdates: any[] = [];
			const onUpdate = (update: any) => {
				receivedUpdates.push(update);
			};

			handleNextRequest((req) => {
				expect(req.method).toBe("session/prompt");
				expect(req.params.sessionId).toBe("sess-stream");
				// String prompt normalized to text block
				expect(req.params.prompt).toEqual([{ type: "text", text: "Write tests" }]);

				// Emit streaming notifications
				const notif1: JsonRpcNotification = {
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "sess-stream",
						updateType: "chunk",
						content: "Hello ",
					},
				};
				const notifTool: JsonRpcNotification = {
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "sess-stream",
						updateType: "tool_call",
						toolCall: { id: "call-1", name: "bash", args: { command: "ls" } },
					},
				};
				const notif2: JsonRpcNotification = {
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "sess-stream",
						updateType: "chunk",
						content: { text: "world!" },
					},
				};
				// Notification for another session should be ignored by this prompt
				const notifOther: JsonRpcNotification = {
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "other-session",
						updateType: "chunk",
						content: "ignore me",
					},
				};

				clientIn.write(JSON.stringify(notif1) + "\n");
				clientIn.write(JSON.stringify(notifTool) + "\n");
				clientIn.write(JSON.stringify(notifOther) + "\n");
				clientIn.write(JSON.stringify(notif2) + "\n");

				return {
					jsonrpc: "2.0",
					id: req.id,
					result: {
						status: "completed",
					},
				};
			});

			const promptResult = await client.sessionPrompt("sess-stream", "Write tests", onUpdate);

			expect(promptResult.fullText).toBe("Hello world!");
			expect(promptResult.toolCalls.length).toBe(1);
			expect(promptResult.toolCalls[0].name).toBe("bash");
			expect(receivedUpdates.length).toBe(3);
			expect(receivedUpdates.every((u) => u.sessionId === "sess-stream")).toBe(true);
		});

		it("falls back to rawResult text when no streaming chunks are received", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			handleNextRequest((req) => {
				expect(req.method).toBe("session/prompt");
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: {
						text: "Fallback output directly in response",
						toolCalls: [{ name: "read_file" }],
					},
				};
			});

			const promptResult = await client.sessionPrompt("sess-fallback", [{ type: "text", text: "query" }]);
			expect(promptResult.fullText).toBe("Fallback output directly in response");
			expect(promptResult.toolCalls.length).toBe(1);
			expect(promptResult.toolCalls[0].name).toBe("read_file");
		});

		it("handles pre-aborted signal by cancelling and rejecting", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			let cancelCalled = false;
			handleNextRequest((req) => {
				if (req.method === "session/cancel") {
					cancelCalled = true;
					return {
						jsonrpc: "2.0",
						id: req.id,
						result: { ok: true },
					};
				}
			});

			const controller = new AbortController();
			controller.abort(new Error("Pre-aborted test"));

			await expect(
				client.sessionPrompt("sess-abort", "Hello", undefined, controller.signal),
			).rejects.toThrow("Pre-aborted test");

			expect(cancelCalled).toBe(true);
		});

		it("handles abort signal triggered while prompt is in flight", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();

			const controller = new AbortController();
			let cancelReceived = false;

			handleNextRequest((req) => {
				if (req.method === "session/prompt") {
					// Simulate server waiting; listen for cancel
					handleNextRequest((cancelReq) => {
						if (cancelReq.method === "session/cancel") {
							cancelReceived = true;
							return {
								jsonrpc: "2.0",
								id: cancelReq.id,
								result: { ok: true },
							};
						}
					});
					// Trigger client abort
					setTimeout(() => {
						controller.abort(new Error("Mid-flight abort"));
					}, 10);
					// Don't respond to prompt immediately
				}
			});

			await expect(
				client.sessionPrompt("sess-mid-abort", "Wait for me", undefined, controller.signal),
			).rejects.toThrow("Mid-flight abort");

			// Give tiny event loop turn for cancel round-trip
			await new Promise((r) => setTimeout(r, 20));
			expect(cancelReceived).toBe(true);
		});

		it("updates isAlive() when stopped", async () => {
			handleNextRequest((req) => ({
				jsonrpc: "2.0",
				id: req.id,
				result: { protocolVersion: 1 },
			}));
			await client.start();
			expect(client.isAlive()).toBe(true);

			await client.stop();
			expect(client.isAlive()).toBe(false);
		});
	});

	describe("Subprocess Lifecycle", () => {
		it("spawns a real process, initializes, and terminates cleanly on stop()", async () => {
			// Inline node/bun script acting as mock ACP server over stdio
			const serverScript = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "mock-proc", version: "1.0.0" }
      }
    }) + "\\n");
  }
});
`;

			const client = new AcpClient({
				command: "bun",
				args: ["-e", serverScript],
				timeoutMs: 5000,
			});

			expect(client.isAlive()).toBe(false);

			const initResult = await client.start();
			expect(initResult.protocolVersion).toBe(1);
			expect(initResult.agentInfo?.name).toBe("mock-proc");
			expect(client.isAlive()).toBe(true);

			await client.stop();
			expect(client.isAlive()).toBe(false);
		});

		it("rejects start() if command binary does not exist", async () => {
			const client = new AcpClient({
				command: "nonexistent-binary-cmd-xyz-987",
				args: [],
				timeoutMs: 2000,
			});

			await expect(client.start()).rejects.toThrow();
			expect(client.isAlive()).toBe(false);
		});
	});
});
