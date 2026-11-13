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

export const MAX_ACP_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB threshold

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
	private readonly endHandler: () => void;
	private readonly inErrorHandler: (err: Error) => void;
	private readonly outErrorHandler: (err: Error) => void;

	constructor(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
		this.inStream = inStream;
		this.outStream = outStream;

		this.dataHandler = (chunk: Buffer | string) => {
			this.handleData(chunk);
		};

		this.endHandler = () => {
			this.close(new AcpTransportError("Input stream closed"));
		};

		this.inErrorHandler = (err: Error) => {
			this.close(new AcpTransportError(`Input stream error: ${err.message}`));
		};

		this.outErrorHandler = (err: Error) => {
			this.close(new AcpTransportError(`Output stream error: ${err.message}`));
		};

		this.inStream.on("data", this.dataHandler);
		this.inStream.on("end", this.endHandler);
		this.inStream.on("close", this.endHandler);
		this.inStream.on("error", this.inErrorHandler);
		this.outStream.on("error", this.outErrorHandler);
	}

	get isClosed(): boolean {
		return this.closed;
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

	close(reason?: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		if (typeof (this.inStream as any).removeListener === "function") {
			(this.inStream as any).removeListener("data", this.dataHandler);
			(this.inStream as any).removeListener("end", this.endHandler);
			(this.inStream as any).removeListener("close", this.endHandler);
			(this.inStream as any).removeListener("error", this.inErrorHandler);
		}

		if (typeof (this.outStream as any).removeListener === "function") {
			(this.outStream as any).removeListener("error", this.outErrorHandler);
		}

		const abortErr = reason ?? new AcpTransportError("Transport closed");
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
		const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.buffer += str;

		if (this.buffer.length > MAX_ACP_BUFFER_SIZE) {
			this.buffer = "";
			this.close(new AcpTransportError("Buffer limit exceeded (16MB)"));
			return;
		}

		let newlineIdx: number;
		while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newlineIdx).trim();
			this.buffer = this.buffer.slice(newlineIdx + 1);

			if (!line) {
				continue;
			}

			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object") {
					continue;
				}
				this.handleMessage(parsed as JsonRpcMessage);
			} catch {
				// Ignore malformed JSON lines
			}
		}
	}

	private handleMessage(msg: JsonRpcMessage): void {
		// Response message
		if ("id" in msg && msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
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
