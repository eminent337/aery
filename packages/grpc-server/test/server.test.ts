import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { GrpcServer } from "../src/server";

// Mock the SDK module to avoid launching actual agent subprocesses/LLMs during tests
mock.module("@aryee337/aery/sdk", () => {
	return {
		createAgentSession: async () => {
			let listener: (event: any) => void;
			return {
				session: {
					subscribe: (l: any) => {
						listener = l;
						return () => {};
					},
					prompt: async (text: string) => {
						// Stream back the chunk event
						if (listener) {
							listener({ type: "chunk", text: `Echo: ${text}`, isFinal: true });
						}
					},
					dispose: () => {},
				},
			};
		},
	};
});

const PROTO_PATH = path.join(__dirname, "../proto/aery.proto");
const TEST_PORT = 50066;

describe("gRPC Server Integration", () => {
	let server: GrpcServer;
	let client: any;

	beforeAll(async () => {
		server = new GrpcServer("127.0.0.1", TEST_PORT);
		await server.start();

		const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
		});
		const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
		client = new protoDescriptor.aery.AeryAgent(`127.0.0.1:${TEST_PORT}`, grpc.credentials.createInsecure());
	});

	afterAll(async () => {
		client.close();
		await server.stop();
	});

	it("responds to Ping", done => {
		client.Ping({}, (err: any, response: any) => {
			expect(err).toBeNull();
			expect(response.version).toBe("0.1.0");
			expect(Number(response.uptime_ms)).toBeGreaterThan(0);
			done();
		});
	});

	it("creates a new session", done => {
		client.CreateSession({ model: "test-model" }, (err: any, response: any) => {
			expect(err).toBeNull();
			expect(response.session_id).toBeDefined();
			expect(response.session_id.startsWith("session-")).toBe(true);
			done();
		});
	});

	it("echoes message stream", done => {
		const call = client.SendMessage();
		let responseReceived = false;

		call.on("data", (msg: any) => {
			if (msg.payload === "text_chunk") {
				expect(msg.session_id).toBe("test-session");
				expect(msg.text_chunk?.text).toBe("Echo: Hello Aery");
				responseReceived = true;
			} else if (msg.payload === "done") {
				call.end();
			}
		});

		call.on("end", () => {
			expect(responseReceived).toBe(true);
			done();
		});

		call.write({
			session_id: "test-session",
			text: { content: "Hello Aery" },
		});
	});
});
