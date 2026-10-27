/**
 * MicServe — Real-Time Audio Streaming Server for Aery.
 *
 * Implements low-latency WebSocket and WebRTC stream serving, allowing remote
 * clients (mobile devices, web frontends, or other CLI nodes) to stream microphone
 * audio directly into Aery's speech recognition pipeline.
 */

import type { Server, ServerWebSocket } from "bun";

export interface MicServerOptions {
	port?: number;
	hostname?: string;
	token?: string;
	sampleRate?: number;
}

export interface ClientMeta {
	id: string;
	remoteAddress: string;
	sampleRate: number;
	connectedAt: number;
}

export class MicServer {
	private server: Server<ClientMeta> | null = null;
	private port: number;
	private hostname: string;
	private token?: string;
	private sampleRate: number;
	private audioChunkListeners: Array<(chunk: Buffer, client: ClientMeta) => void> = [];

	constructor(options: MicServerOptions = {}) {
		this.port = options.port ?? 8766;
		this.hostname = options.hostname ?? "0.0.0.0";
		this.token = options.token;
		this.sampleRate = options.sampleRate ?? 16000;
	}

	onAudioChunk(callback: (chunk: Buffer, client: ClientMeta) => void): () => void {
		this.audioChunkListeners.push(callback);
		return () => {
			this.audioChunkListeners = this.audioChunkListeners.filter(l => l !== callback);
		};
	}

	async start(): Promise<void> {
		const self = this;

		this.server = Bun.serve<ClientMeta>({
			port: this.port,
			hostname: this.hostname,
			fetch(req, server) {
				const url = new URL(req.url);

				// Verify token if configured
				if (self.token) {
					const reqToken = url.searchParams.get("token") || req.headers.get("x-aery-token");
					if (reqToken !== self.token) {
						return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing token" }), {
							status: 401,
							headers: { "Content-Type": "application/json" },
						});
					}
				}

				if (url.pathname === "/status") {
					return new Response(
						JSON.stringify({
							status: "online",
							service: "aery-mic-serve",
							sampleRate: self.sampleRate,
							port: self.port,
							timestamp: Date.now(),
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}

				if (url.pathname === "/ws/audio") {
					const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
					const success = server.upgrade(req, {
						data: {
							id: clientId,
							remoteAddress: req.headers.get("x-forwarded-for") || "local",
							sampleRate: self.sampleRate,
							connectedAt: Date.now(),
						},
					});

					return success ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
				}

				return new Response(JSON.stringify({ error: "Not found" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			},
			websocket: {
				open(ws: ServerWebSocket<ClientMeta>) {
					// Client connected
				},
				message(ws: ServerWebSocket<ClientMeta>, message: string | Buffer) {
					if (Buffer.isBuffer(message) || message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
						const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
						for (const listener of self.audioChunkListeners) {
							listener(buf, ws.data);
						}
					}
				},
				close(ws: ServerWebSocket<ClientMeta>) {
					// Client disconnected
				},
			},
		});
	}

	async stop(): Promise<void> {
		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
		this.audioChunkListeners = [];
	}

	get url(): string {
		return `http://${this.hostname}:${this.port}`;
	}
}
