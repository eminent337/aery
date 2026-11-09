import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { AcpTransport, AcpTimeoutError, AcpRpcError } from "../../src/acp/transport";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../../src/acp/types";

describe("AcpTransport", () => {
	let inStream: PassThrough;
	let outStream: PassThrough;
	let transport: AcpTransport;

	beforeEach(() => {
		inStream = new PassThrough();
		outStream = new PassThrough();
		transport = new AcpTransport(inStream, outStream);
	});

	afterEach(() => {
		transport.close();
	});

	describe("Message serialization", () => {
		it("sends notifications formatted as JSON-RPC with newline delimiter", async () => {
			const chunks: string[] = [];
			outStream.on("data", (chunk: Buffer) => {
				chunks.push(chunk.toString("utf8"));
			});

			transport.notify("test/notify", { foo: "bar" });

			const combined = chunks.join("");
			expect(combined.endsWith("\n")).toBe(true);

			const parsed = JSON.parse(combined.trim()) as JsonRpcNotification;
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.method).toBe("test/notify");
			expect(parsed.params).toEqual({ foo: "bar" });
			expect((parsed as any).id).toBeUndefined();
		});

		it("sends requests with incrementing numeric id", async () => {
			const sentMessages: any[] = [];
			outStream.on("data", (chunk: Buffer) => {
				for (const line of chunk.toString("utf8").split("\n")) {
					if (line.trim()) {
						sentMessages.push(JSON.parse(line));
					}
				}
			});

			// Issue request without awaiting resolution
			const reqPromise = transport.request("session/new", { cwd: "/tmp" });

			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0].jsonrpc).toBe("2.0");
			expect(sentMessages[0].method).toBe("session/new");
			expect(sentMessages[0].params).toEqual({ cwd: "/tmp" });
			expect(sentMessages[0].id).toBe(1);

			// Send matching response back
			inStream.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: sentMessages[0].id,
					result: { sessionId: "s-123" },
				}) + "\n",
			);

			const result = await reqPromise;
			expect(result).toEqual({ sessionId: "s-123" });
		});
	});

	describe("Line-delimited stream parsing", () => {
		it("parses fragmented data chunks correctly", async () => {
			const received: JsonRpcNotification[] = [];
			transport.onNotification((notif) => {
				received.push(notif);
			});

			const payload = JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: { updateType: "agent_chunk", content: "hello" },
			});

			// Split payload into partial chunks
			const part1 = payload.slice(0, 15);
			const part2 = payload.slice(15, 30);
			const part3 = payload.slice(30) + "\n";

			inStream.write(part1);
			expect(received.length).toBe(0);

			inStream.write(part2);
			expect(received.length).toBe(0);

			inStream.write(part3);
			expect(received.length).toBe(1);
			expect(received[0].method).toBe("session/update");
			expect(received[0].params.content).toBe("hello");
		});

		it("parses multiple messages in a single chunk", async () => {
			const received: JsonRpcNotification[] = [];
			transport.onNotification((notif) => {
				received.push(notif);
			});

			const msg1 = JSON.stringify({ jsonrpc: "2.0", method: "msg1", params: { n: 1 } });
			const msg2 = JSON.stringify({ jsonrpc: "2.0", method: "msg2", params: { n: 2 } });

			inStream.write(`${msg1}\n${msg2}\n`);

			expect(received.length).toBe(2);
			expect(received[0].method).toBe("msg1");
			expect(received[1].method).toBe("msg2");
		});

		it("ignores blank lines and malformed json gracefully", async () => {
			const received: JsonRpcNotification[] = [];
			transport.onNotification((notif) => {
				received.push(notif);
			});

			inStream.write("\n\n   \n");
			inStream.write("not valid json\n");
			inStream.write(JSON.stringify({ jsonrpc: "2.0", method: "valid" }) + "\n");

			expect(received.length).toBe(1);
			expect(received[0].method).toBe("valid");
		});
	});

	describe("Request correlation and notifications", () => {
		it("correlates concurrent requests with out-of-order responses", async () => {
			const responses: any[] = [];
			outStream.on("data", (chunk: Buffer) => {
				for (const line of chunk.toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					const parsed = JSON.parse(line) as JsonRpcRequest;
					responses.push(parsed);
				}
			});

			const p1 = transport.request<{ val: number }>("op1");
			const p2 = transport.request<{ val: number }>("op2");

			expect(responses.length).toBe(2);
			const id1 = responses[0].id;
			const id2 = responses[1].id;

			// Respond out of order: 2 then 1
			inStream.write(JSON.stringify({ jsonrpc: "2.0", id: id2, result: { val: 20 } }) + "\n");
			inStream.write(JSON.stringify({ jsonrpc: "2.0", id: id1, result: { val: 10 } }) + "\n");

			const res2 = await p2;
			const res1 = await p1;

			expect(res1).toEqual({ val: 10 });
			expect(res2).toEqual({ val: 20 });
		});

		it("allows unsubscribing from notifications", async () => {
			const received: string[] = [];
			const unsubscribe = transport.onNotification((notif) => {
				received.push(notif.method);
			});

			inStream.write(JSON.stringify({ jsonrpc: "2.0", method: "notif.one" }) + "\n");
			expect(received).toEqual(["notif.one"]);

			unsubscribe();

			inStream.write(JSON.stringify({ jsonrpc: "2.0", method: "notif.two" }) + "\n");
			expect(received).toEqual(["notif.one"]);
		});
	});

	describe("Error handling and timeouts", () => {
		it("rejects request when JSON-RPC error response is received", async () => {
			let reqId: number | string | undefined;
			outStream.on("data", (chunk: Buffer) => {
				const line = chunk.toString("utf8").trim();
				if (line) {
					const parsed = JSON.parse(line);
					reqId = parsed.id;
				}
			});

			const reqPromise = transport.request("session/invalid");

			inStream.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: reqId,
					error: {
						code: -32601,
						message: "Method not found",
						data: { detail: "Unknown RPC method" },
					},
				}) + "\n",
			);

			await expect(reqPromise).rejects.toThrow("Method not found");
			try {
				await reqPromise;
			} catch (err: any) {
				expect(err).toBeInstanceOf(AcpRpcError);
				expect(err.code).toBe(-32601);
				expect(err.data).toEqual({ detail: "Unknown RPC method" });
			}
		});

		it("rejects request on timeout", async () => {
			const reqPromise = transport.request("session/prompt", {}, 50);

			await expect(reqPromise).rejects.toThrow(AcpTimeoutError);
		});

		it("rejects pending requests when transport is closed", async () => {
			const reqPromise = transport.request("long/running", {}, 10000);

			transport.close();

			await expect(reqPromise).rejects.toThrow("Transport closed");
		});

		it("rejects requests attempted after transport is closed", async () => {
			transport.close();
			await expect(transport.request("after/close")).rejects.toThrow("Transport closed");
		});
	});
});
