import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../registry/agent-registry";
import { WebHubServer } from "../web-hub-server";

describe("Interactive Web Hub Server (aery hub / --hub)", () => {
	let hub: WebHubServer;
	let hubUrl: string;

	beforeEach(async () => {
		hub = new WebHubServer({ port: 0, host: "127.0.0.1" });
		const res = await hub.start();
		hubUrl = res.url;
	});

	afterEach(async () => {
		await hub.stop();
	});

	it("serves HTML dashboard on root GET /", async () => {
		const res = await fetch(`${hubUrl}/`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("Aery Interactive Web Hub");
		expect(text).toContain("Subagents");
		expect(text).toContain("Sidecar Daemons");
	});

	it("returns status JSON from /api/status", async () => {
		const res = await fetch(`${hubUrl}/api/status`);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { status: string; hostname: string; cwd: string };
		expect(json.status).toBe("running");
		expect(json.hostname).toBeDefined();
		expect(json.cwd).toBeDefined();
	});

	it("lists agents from /api/agents", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "hub-tester",
			displayName: "Hub QA Tester",
			kind: "sub",
			status: "idle",
			session: null,
		});

		const res = await fetch(`${hubUrl}/api/agents`);
		expect(res.status).toBe(200);
		const agents = (await res.json()) as Array<{ id: string; displayName: string }>;
		expect(Array.isArray(agents)).toBe(true);
		const found = agents.find(a => a.id === "hub-tester");
		expect(found).toBeDefined();
		expect(found?.displayName).toBe("Hub QA Tester");
	});

	it("connects over WebSocket to /ws and receives initial handshake", async () => {
		const wsUrl = `${hubUrl.replace("http://", "ws://")}/ws`;
		const ws = new WebSocket(wsUrl);

		const messageReceived = await new Promise<any>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 2000);
			ws.onmessage = event => {
				clearTimeout(timeout);
				resolve(JSON.parse(String(event.data)));
			};
			ws.onerror = err => {
				clearTimeout(timeout);
				reject(err);
			};
		});

		expect(messageReceived.type).toBe("connected");
		expect(messageReceived.payload.server).toBe("aery-web-hub");
		ws.close();
	});
});
