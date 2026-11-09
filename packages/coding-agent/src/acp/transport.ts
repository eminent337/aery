import type {
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
} from "./types";

export class AcpTimeoutError extends Error {
	constructor(message = "ACP request timed out") {
		super(message);
		this.name = "AcpTimeoutError";
	}
}

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data?: any;

	constructor(code: number, message: string, data?: any) {
		super(message);
		this.name = "AcpRpcError";
		this.code = code;
		this.data = data;
	}
}

export class AcpTransportError extends Error {
	constructor(message = "ACP transport error") {
		super(message);
		this.name = "AcpTransportError";
	}
}

interface PendingRequest {
	resolve: (val: any) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export class AcpTransport {
	private readonly inStream: NodeJS.ReadableStream;
	private readonly outStream: NodeJS.WritableStream;
	private buffer = "";
	private nextId = 1;
	private closed = false;
	private readonly pendingRequests = new Map<number | string, PendingRequest>();
	private readonly notificationListeners = new Set<(notif: JsonRpcNotification) => void>();
	private readonly dataHandler: (chunk: Buffer | string) => void;

	constructor(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
		this.inStream = inStream;
		this.outStream = outStream;

		this.dataHandler = (chunk: Buffer | string) => {
			this.handleData(chunk);
		};

		this.inStream.on("data", this.dataHandler);
	}

	sendMessage(msg: JsonRpcMessage): void {
		if (this.closed) {
			throw new AcpTransportError("Transport closed");
		}
		const line = JSON.stringify(msg) + "\n";
		this.outStream.write(line);
	}

	request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
		if (this.closed) {
			return Promise.reject(new AcpTransportError("Transport closed"));
		}

		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;

			if (timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY) {
				timer = setTimeout(() => {
					this.pendingRequests.delete(id);
					reject(
						new AcpTimeoutError(
							`ACP request '${method}' (id: ${id}) timed out after ${timeoutMs}ms`,
						),
					);
				}, timeoutMs);
			}

			this.pendingRequests.set(id, { resolve, reject, timer });

			try {
				const req: JsonRpcRequest = {
					jsonrpc: "2.0",
					id,
					method,
					params,
				};
				this.sendMessage(req);
			} catch (err) {
				if (timer) {
					clearTimeout(timer);
				}
				this.pendingRequests.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	notify(method: string, params?: any): void {
		if (this.closed) {
			throw new AcpTransportError("Transport closed");
		}
		const notif: JsonRpcNotification = {
			jsonrpc: "2.0",
			method,
			params,
		};
		this.sendMessage(notif);
	}

	onNotification(listener: (notif: JsonRpcNotification) => void): () => void {
		this.notificationListeners.add(listener);
		return () => {
			this.notificationListeners.delete(listener);
		};
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		if (typeof (this.inStream as any).removeListener === "function") {
			(this.inStream as any).removeListener("data", this.dataHandler);
		}

		const abortErr = new AcpTransportError("Transport closed");
		for (const pending of this.pendingRequests.values()) {
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
			pending.reject(abortErr);
		}
		this.pendingRequests.clear();
		this.notificationListeners.clear();
	}

	private handleData(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

		let newlineIdx: number;
		while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newlineIdx).trim();
			this.buffer = this.buffer.slice(newlineIdx + 1);

			if (!line) {
				continue;
			}

			try {
				const parsed = JSON.parse(line) as JsonRpcMessage;
				this.handleMessage(parsed);
			} catch {
				// Ignore malformed JSON lines
			}
		}
	}

	private handleMessage(msg: JsonRpcMessage): void {
		// Response message
		if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg)) {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				if (pending.timer) {
					clearTimeout(pending.timer);
				}
				this.pendingRequests.delete(msg.id);

				const resp = msg as JsonRpcResponse;
				if (resp.error) {
					pending.reject(
						new AcpRpcError(resp.error.code, resp.error.message, resp.error.data),
					);
				} else {
					pending.resolve(resp.result);
				}
			}
			return;
		}

		// Notification message (no id)
		if ("method" in msg && (!("id" in msg) || msg.id === undefined)) {
			const notif = msg as JsonRpcNotification;
			for (const listener of Array.from(this.notificationListeners)) {
				try {
					listener(notif);
				} catch {
					// Listener errors shouldn't crash transport
				}
			}
		}
	}
}
