import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBusClient, AgentBusServer } from "../agent-bus";

describe("Agent IPC Message Bus", () => {
	let socketPath: string;
	let server: AgentBusServer;

	beforeAll(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-ipc-test-"));
		socketPath = path.join(tmpDir, "test.sock");
		server = new AgentBusServer(socketPath);

		// Register a test handler for "get_metadata"
		server.registerHandler("get_metadata", async req => {
			return {
				conversationId: req.payload.conversationId,
				status: "active",
				title: "Test Agent Conversation",
			};
		});

		await server.start();
	});

	afterAll(async () => {
		await server.close();
		try {
			await fs.unlink(socketPath);
		} catch {}
	});

	it("connects client and performs request-response", async () => {
		const client = new AgentBusClient(socketPath, "client-agent-1");
		await client.connect();

		const res = await client.request("get_metadata", { conversationId: "conv-123" });
		expect(res.success).toBe(true);
		expect(res.payload.conversationId).toBe("conv-123");
		expect(res.payload.status).toBe("active");

		await client.close();
	});

	it("dispatches reactive events between agents", async () => {
		const client1 = new AgentBusClient(socketPath, "agent-alice");
		const client2 = new AgentBusClient(socketPath, "agent-bob");

		await client1.connect();
		await client2.connect();

		const receivedEvents: any[] = [];
		client2.onEvent(event => {
			receivedEvents.push(event);
		});

		// Server routes message from Alice to Bob
		await server.emitTo("agent-bob", {
			type: "message_received",
			senderId: "agent-alice",
			text: "Hello Bob!",
		});

		// Wait briefly for socket delivery
		await new Promise(r => setTimeout(r, 50));

		expect(receivedEvents.length).toBe(1);
		expect(receivedEvents[0].senderId).toBe("agent-alice");
		expect(receivedEvents[0].text).toBe("Hello Bob!");

		await client1.close();
		await client2.close();
	});
});
