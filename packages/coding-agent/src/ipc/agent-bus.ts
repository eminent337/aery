/**
 * Agent Bus IPC — Unix Domain Socket Message Bus.
 *
 * Implements a high-throughput, asynchronous IPC daemon for inter-agent communication,
 * metadata querying, and reactive wakeups (modeled after agy's agentapi).
 */

import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentIPCRequest<T = any> {
	id: string;
	type: string;
	senderId: string;
	payload: T;
}

export interface AgentIPCResponse<T = any> {
	id: string;
	success: boolean;
	error?: string;
	payload?: T;
}

export interface AgentIPCEvent {
	type: string;
	senderId?: string;
	recipientId?: string;
	[key: string]: any;
}

export type RequestHandler = (req: AgentIPCRequest) => Promise<any>;

export function getDefaultSocketPath(sessionId = "default"): string {
	const runDir = path.join(os.homedir(), ".aery", "run");
	return path.join(runDir, `aery-ipc-${sessionId}.sock`);
}

/**
 * IPC Server managing connections and routing messages across agents.
 */
export class AgentBusServer {
	private server: net.Server | null = null;
	private handlers = new Map<string, RequestHandler>();
	private clients = new Map<string, net.Socket>();
	private socketPath: string;

	constructor(socketPath?: string) {
		this.socketPath = socketPath ?? getDefaultSocketPath();
	}

	registerHandler(type: string, handler: RequestHandler): void {
		this.handlers.set(type, handler);
	}

	async start(): Promise<void> {
		await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
		try {
			await fs.unlink(this.socketPath);
		} catch {}

		return new Promise((resolve, reject) => {
			this.server = net.createServer(socket => {
				let buffer = "";
				let registeredAgentId: string | undefined;

				socket.on("data", async data => {
					buffer += data.toString("utf-8");
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const msg = JSON.parse(line);

							// Client handshake
							const agentId = msg.payload?.agentId ?? msg.agentId;
							if (msg.type === "register" && agentId) {
								registeredAgentId = agentId;
								this.clients.set(agentId, socket);
								socket.write(`${JSON.stringify({ id: msg.id, success: true })}\n`);
								continue;
							}

							const handler = this.handlers.get(msg.type);
							if (handler) {
								try {
									const result = await handler(msg);
									const resp: AgentIPCResponse = { id: msg.id, success: true, payload: result };
									socket.write(`${JSON.stringify(resp)}\n`);
								} catch (err: any) {
									const resp: AgentIPCResponse = {
										id: msg.id,
										success: false,
										error: err.message || String(err),
									};
									socket.write(`${JSON.stringify(resp)}\n`);
								}
							} else {
								const resp: AgentIPCResponse = {
									id: msg.id,
									success: false,
									error: `Unknown request type: ${msg.type}`,
								};
								socket.write(`${JSON.stringify(resp)}\n`);
							}
						} catch {
							socket.write(`${JSON.stringify({ success: false, error: "Invalid JSON frame" })}\n`);
						}
					}
				});

				socket.on("close", () => {
					if (registeredAgentId) {
						this.clients.delete(registeredAgentId);
					}
				});

				socket.on("error", () => {
					if (registeredAgentId) {
						this.clients.delete(registeredAgentId);
					}
				});
			});

			this.server.on("error", reject);
			this.server.listen(this.socketPath, () => resolve());
		});
	}

	async emitTo(recipientId: string, event: AgentIPCEvent): Promise<boolean> {
		const socket = this.clients.get(recipientId);
		if (socket && !socket.destroyed) {
			socket.write(`${JSON.stringify(event)}\n`);
			return true;
		}
		return false;
	}

	async broadcast(event: AgentIPCEvent): Promise<void> {
		const payload = `${JSON.stringify(event)}\n`;
		for (const socket of this.clients.values()) {
			if (!socket.destroyed) {
				socket.write(payload);
			}
		}
	}

	async close(): Promise<void> {
		for (const socket of this.clients.values()) {
			socket.destroy();
		}
		this.clients.clear();

		if (this.server) {
			await new Promise<void>(resolve => {
				this.server?.close(() => resolve());
			});
			this.server = null;
		}
		try {
			await fs.unlink(this.socketPath);
		} catch {}
	}
}

/**
 * IPC Client used by CLI commands or subagents to send and receive events.
 */
export class AgentBusClient {
	private socket: net.Socket | null = null;
	private pending = new Map<string, { resolve: (res: AgentIPCResponse) => void; reject: (err: any) => void }>();
	private eventListeners: Array<(event: AgentIPCEvent) => void> = [];
	private buffer = "";

	constructor(
		private socketPath: string,
		private agentId: string,
	) {}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection(this.socketPath, async () => {
				try {
					// Register agent ID with the bus
					await this.request("register", { agentId: this.agentId });
					resolve();
				} catch (err) {
					reject(err);
				}
			});

			this.socket.on("data", data => {
				this.buffer += data.toString("utf-8");
				const lines = this.buffer.split("\n");
				this.buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						if (msg.id && this.pending.has(msg.id)) {
							const handler = this.pending.get(msg.id)!;
							this.pending.delete(msg.id);
							handler.resolve(msg);
						} else {
							// Inbound broadcast/event
							for (const listener of this.eventListeners) {
								listener(msg);
							}
						}
					} catch {}
				}
			});

			this.socket.on("error", reject);
		});
	}

	async request<T = any>(type: string, payload: any): Promise<AgentIPCResponse<T>> {
		if (!this.socket || this.socket.destroyed) {
			throw new Error("AgentBusClient is not connected");
		}
		const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const frame: AgentIPCRequest = {
			id,
			type,
			senderId: this.agentId,
			payload,
		};

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket!.write(`${JSON.stringify(frame)}\n`);
		});
	}

	onEvent(callback: (event: AgentIPCEvent) => void): () => void {
		this.eventListeners.push(callback);
		return () => {
			this.eventListeners = this.eventListeners.filter(l => l !== callback);
		};
	}

	async close(): Promise<void> {
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
		this.pending.clear();
		this.eventListeners = [];
	}
}
