import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MicServer } from "../webrtc-serve";

describe("MicServe Audio Stream Server", () => {
	let server: MicServer;
	const testPort = 18766;
	const testToken = "secret-token-123";

	beforeAll(async () => {
		server = new MicServer({
			port: testPort,
			token: testToken,
			sampleRate: 16000,
		});
		await server.start();
	});

	afterAll(async () => {
		await server.stop();
	});

	it("serves status endpoint with authentication check", async () => {
		// Unauthorized request without token
		const unauthRes = await fetch(`http://localhost:${testPort}/status`);
		expect(unauthRes.status).toBe(401);

		// Authorized request with token
		const authRes = await fetch(`http://localhost:${testPort}/status?token=${testToken}`);
		expect(authRes.status).toBe(200);

		const data = await authRes.json();
		expect(data.status).toBe("online");
		expect(data.sampleRate).toBe(16000);
	});

	it("accepts binary audio chunks via WebSocket connection", async () => {
		const ws = new WebSocket(`ws://localhost:${testPort}/ws/audio?token=${testToken}`);

		const openPromise = new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = e => reject(e);
		});

		await openPromise;

		let chunkReceived = false;
		server.onAudioChunk((chunk, clientMeta) => {
			chunkReceived = true;
			expect(chunk.byteLength).toBe(320); // 160 16-bit samples
		});

		// Send 160 samples (320 bytes) of PCM audio
		const pcmData = new Int16Array(160);
		ws.send(pcmData.buffer);

		// Wait briefly for delivery
		await new Promise(r => setTimeout(r, 100));

		expect(chunkReceived).toBe(true);
		ws.close();
	});
});
