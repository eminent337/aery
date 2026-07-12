import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { SessionManager } from "./session-manager";

const PROTO_PATH = path.join(__dirname, "../proto/aery.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
	keepCase: true,
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const aeryProto = protoDescriptor.aery;

export class GrpcServer {
	#server: grpc.Server;
	#sessionManager: SessionManager;
	#port: number;
	#host: string;

	constructor(host = "127.0.0.1", port = 50051) {
		this.#server = new grpc.Server();
		this.#sessionManager = new SessionManager();
		this.#host = host;
		this.#port = port;

		this.#server.addService(aeryProto.AeryAgent.service, {
			CreateSession: this.createSession.bind(this),
			ListSessions: this.listSessions.bind(this),
			GetSessionInfo: this.getSessionInfo.bind(this),
			CancelRequest: this.cancelRequest.bind(this),
			Ping: this.ping.bind(this),
			SendMessage: this.sendMessage.bind(this),
		});
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#server.bindAsync(
				`${this.#host}:${this.#port}`,
				grpc.ServerCredentials.createInsecure(),
				(err, bindPort) => {
					if (err) {
						reject(err);
						return;
					}
					this.#server.start();
					console.log(`gRPC Server running at ${this.#host}:${bindPort}`);
					resolve();
				},
			);
		});
	}

	stop(): Promise<void> {
		return new Promise(resolve => {
			this.#server.tryShutdown(() => {
				resolve();
			});
		});
	}

	createSession(call: any, callback: any): void {
		const sessionId = `session-${Math.random().toString(36).substring(2, 10)}`;
		callback(null, { session_id: sessionId });
	}

	async listSessions(call: any, callback: any): Promise<void> {
		const list = await this.#sessionManager.listSessions();
		callback(null, {
			sessions: list.map(s => ({
				session_id: s.sessionId,
				model: s.model,
				created_at: Math.floor(s.createdAt),
				message_count: s.messageCount,
			})),
		});
	}

	getSessionInfo(call: any, callback: any): void {
		callback(null, {
			session_id: call.request.session_id,
			model: "mock-model",
			created_at: Date.now(),
			message_count: 0,
		});
	}

	cancelRequest(call: any, callback: any): void {
		callback(null, { success: true });
	}

	ping(call: any, callback: any): void {
		callback(null, {
			version: "0.1.0",
			uptime_ms: process.uptime() * 1000,
		});
	}

	sendMessage(call: any): void {
		call.on("data", (msg: any) => {
			call.write({
				session_id: msg.session_id,
				text_chunk: { text: `Echo: ${msg.text?.content || ""}`, is_final: true },
			});
		});
		call.on("end", () => {
			call.end();
		});
	}
}
