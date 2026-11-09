import { spawn, type ChildProcess } from "node:child_process";
import { AcpTransport } from "./transport";
import type {
	AcpClientInfo,
	AcpInitializeResult,
	AcpPromptResult,
	AcpSessionNewResult,
	AcpSessionUpdateNotification,
} from "./types";

export interface AcpClientOptions {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	clientInfo?: AcpClientInfo;
	timeoutMs?: number;
	customTransport?: AcpTransport;
	transport?: AcpTransport;
}

export class AcpClient {
	private readonly options: AcpClientOptions;
	private child?: ChildProcess;
	private childRunning = false;
	private transport?: AcpTransport;
	private initializeResult?: AcpInitializeResult;
	private stopped = false;
	private unsubscribeNotifications?: () => void;
	private readonly promptListeners = new Map<string, Set<(update: AcpSessionUpdateNotification) => void>>();
	private startPromise?: Promise<AcpInitializeResult>;

	constructor(options: AcpClientOptions) {
		this.options = options;
		const configuredTransport = options.customTransport ?? options.transport;
		if (configuredTransport) {
			this.transport = configuredTransport;
		}
	}

	get childProcess(): ChildProcess | undefined {
		return this.child;
	}

	isAlive(): boolean {
		if (this.stopped || !this.transport || !this.initializeResult) {
			return false;
		}
		const closed =
			typeof (this.transport as any).isClosed === "function"
				? (this.transport as any).isClosed()
				: Boolean((this.transport as any).isClosed);
		if (closed) {
			return false;
		}
		if (this.child) {
			return this.childRunning && !this.child.killed && this.child.exitCode === null;
		}
		return true;
	}

	async start(): Promise<AcpInitializeResult> {
		if (this.initializeResult && this.isAlive()) {
			return this.initializeResult;
		}

		if (this.startPromise) {
			return this.startPromise;
		}

		this.startPromise = (async () => {
			try {
				this.stopped = false;

		const configuredTransport = this.options.customTransport ?? this.options.transport;
		if (configuredTransport) {
			this.transport = configuredTransport;
		} else {
			if (!this.options.command) {
				throw new Error("AcpClient requires either a command or a custom transport");
			}
			const env = { ...process.env, ...this.options.env };
			const child = spawn(this.options.command, this.options.args ?? [], {
				cwd: this.options.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});

			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const onSpawn = () => {
					if (!settled) {
						settled = true;
						cleanup();
						resolve();
					}
				};
				const onError = (err: Error) => {
					if (!settled) {
						settled = true;
						cleanup();
						reject(err);
					}
				};
				const cleanup = () => {
					child.removeListener("spawn", onSpawn);
					child.removeListener("error", onError);
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});

			this.child = child;
			this.childRunning = true;

			child.on("exit", () => {
				this.childRunning = false;
			});
			child.on("error", () => {
				this.childRunning = false;
			});

			if (!child.stdout || !child.stdin) {
				throw new Error("Child process stdio streams are not available");
			}

			this.transport = new AcpTransport(child.stdout, child.stdin);
		}

		if (this.unsubscribeNotifications) {
			this.unsubscribeNotifications();
		}

		this.unsubscribeNotifications = this.transport.onNotification((notif) => {
			if (notif.method === "session/update" && notif.params) {
				this.handleSessionUpdate(notif.params as AcpSessionUpdateNotification);
			}
		});

		const clientInfo: AcpClientInfo = this.options.clientInfo ?? {
			name: "aery",
			version: "0.14.0",
		};

		const initResult = await this.transport.request<AcpInitializeResult>(
			"initialize",
			{ protocolVersion: 1, clientInfo },
			this.options.timeoutMs,
		);

		this.initializeResult = initResult;
		return initResult;
			} finally {
				this.startPromise = undefined;
			}
		})();

		return this.startPromise;
	}

	async sessionNew(cwd: string, mcpServers?: any[]): Promise<string> {
		const transport = this.ensureStarted();
		const res = await transport.request<AcpSessionNewResult>(
			"session/new",
			{ cwd, mcpServers },
			this.options.timeoutMs,
		);
		return res.sessionId;
	}

	async sessionLoad(sessionId: string, cwd: string): Promise<void> {
		const transport = this.ensureStarted();
		await transport.request(
			"session/load",
			{ sessionId, cwd },
			this.options.timeoutMs,
		);
	}

	async sessionPrompt(
		sessionId: string,
		prompt: string | Array<{ type: string; text?: string; [key: string]: any }>,
		onUpdate?: (update: AcpSessionUpdateNotification) => void,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<AcpPromptResult> {
		const transport = this.ensureStarted();

		if (signal?.aborted) {
			await this.sessionCancel(sessionId).catch(() => {});
			throw signal.reason ?? new Error("Session prompt aborted");
		}

		const normalizedPrompt = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;

		let fullText = "";
		const toolCalls: any[] = [];

		const promptListener = (update: AcpSessionUpdateNotification) => {
			if (onUpdate) {
				try {
					onUpdate(update);
				} catch {
					// Ignore listener errors
				}
			}

			const target = { text: "", toolCalls: [] as any[] };
			if (update.updateType !== "tool_result" && update.content) {
				this.accumulateContent(update.content, target);
			}
			if ((update as any).text && typeof (update as any).text === "string") {
				target.text += (update as any).text;
			}
			if ((update as any).delta && typeof (update as any).delta === "string") {
				target.text += (update as any).delta;
			}
			if (update.toolCall) {
				target.toolCalls.push(update.toolCall);
			} else if (update.updateType === "tool_call" && update.content && target.toolCalls.length === 0) {
				target.toolCalls.push(update.content);
			}

			fullText += target.text;
			for (const tc of target.toolCalls) {
				toolCalls.push(tc);
			}
		};

		let sessionListeners = this.promptListeners.get(sessionId);
		if (!sessionListeners) {
			sessionListeners = new Set();
			this.promptListeners.set(sessionId, sessionListeners);
		}
		sessionListeners.add(promptListener);

		let abortHandler: (() => void) | undefined;
		const abortPromise = new Promise<never>((_, reject) => {
			if (signal) {
				abortHandler = () => {
					this.sessionCancel(sessionId).catch(() => {});
					reject(signal.reason ?? new Error("Session prompt aborted"));
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		try {
			const rawResult = await Promise.race([
				transport.request<any>(
					"session/prompt",
					{ sessionId, prompt: normalizedPrompt },
					timeoutMs ?? this.options.timeoutMs,
				),
				abortPromise,
			]);

			if (!fullText && rawResult) {
				const rawTarget = { text: "", toolCalls: [] as any[] };
				if (typeof rawResult.text === "string") {
					fullText = rawResult.text;
				} else if (rawResult.content) {
					this.accumulateContent(rawResult.content, rawTarget);
					if (rawTarget.text) {
						fullText = rawTarget.text;
					}
					for (const tc of rawTarget.toolCalls) {
						toolCalls.push(tc);
					}
				}
			}

			if (Array.isArray(rawResult?.toolCalls)) {
				for (const tc of rawResult.toolCalls) {
					toolCalls.push(tc);
				}
			}

			return {
				fullText,
				toolCalls,
				rawResult,
			};
		} finally {
			sessionListeners.delete(promptListener);
			if (sessionListeners.size === 0) {
				this.promptListeners.delete(sessionId);
			}
			if (signal && abortHandler) {
				signal.removeEventListener("abort", abortHandler);
			}
		}
	}

	async sessionCancel(sessionId: string): Promise<void> {
		if (!this.transport) {
			throw new Error("AcpClient is not started");
		}
		await this.transport.request(
			"session/cancel",
			{ sessionId },
			this.options.timeoutMs,
		);
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;

		if (this.unsubscribeNotifications) {
			this.unsubscribeNotifications();
			this.unsubscribeNotifications = undefined;
		}

		if (this.transport) {
			const closed =
				typeof (this.transport as any).isClosed === "function"
					? (this.transport as any).isClosed()
					: Boolean((this.transport as any).isClosed);
			if (!closed) {
				await this.transport.close();
			}
		}

		if (this.child) {
			const pid = this.child.pid;
			if (pid) {
				try {
					if (process.platform !== "win32") {
						process.kill(-pid, "SIGKILL");
					} else {
						this.child.kill("SIGKILL");
					}
				} catch {
					try {
						this.child.kill("SIGKILL");
					} catch {
						// Process already terminated
					}
				}
			}
			this.childRunning = false;
		}
	}

	private ensureStarted(): AcpTransport {
		if (!this.transport || !this.isAlive()) {
			throw new Error("AcpClient is not started");
		}
		return this.transport;
	}

	private handleSessionUpdate(update: AcpSessionUpdateNotification): void {
		if (!update || !update.sessionId) {
			return;
		}
		const listeners = this.promptListeners.get(update.sessionId);
		if (listeners) {
			for (const listener of Array.from(listeners)) {
				try {
					listener(update);
				} catch {
					// Callback error safety
				}
			}
		}
	}

	private accumulateContent(content: any, target: { text: string; toolCalls: any[] }): void {
		if (!content) {
			return;
		}

		if (typeof content === "string") {
			target.text += content;
			return;
		}

		if (Array.isArray(content)) {
			for (const item of content) {
				this.accumulateContent(item, target);
			}
			return;
		}

		if (typeof content === "object") {
			if (typeof content.text === "string") {
				target.text += content.text;
			} else if (typeof content.delta === "string") {
				target.text += content.delta;
			}

			if (content.type === "tool_use" || content.type === "tool_call") {
				target.toolCalls.push(content);
			}
		}
	}
}
