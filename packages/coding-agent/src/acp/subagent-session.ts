import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient } from "./client";
import { createOpencodeAcpClient } from "./adapters/opencode";

const execFileAsync = promisify(execFile);

export interface OpencodeSubagentSessionOptions {
	conversationId: string;
	cwd: string;
	logPath?: string;
	binaryPath?: string;
	env?: NodeJS.ProcessEnv;
	client?: AcpClient;
	timeoutMs?: number;
}

export class OpencodeSubagentSession {
	public readonly conversationId: string;
	public readonly cwd: string;
	public readonly logPath?: string;
	public readonly model = "opencode-acp";
	public readonly tools = ["*"];

	private readonly listeners = new Set<(event: any) => void>();
	private client: AcpClient | null = null;
	private sessionId: string | null = null;
	private lastAssistantText = "";
	private abortController = new AbortController();
	private isDisposed = false;
	private inFlightPrompt: Promise<void> | null = null;
	private promptQueue: Promise<void> = Promise.resolve();
	private initPromise: Promise<AcpClient> | null = null;

	constructor(private readonly options: OpencodeSubagentSessionOptions) {
		this.conversationId = options.conversationId;
		this.cwd = options.cwd;
		this.logPath = options.logPath;
		if (options.client) {
			this.client = options.client;
		}
	}

	get sessionManager(): { getSessionFile: () => string } {
		return {
			getSessionFile: () => this.logPath || "",
		};
	}

	subscribe(cb: (event: any) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	emitEvent(event: any): void {
		for (const listener of Array.from(this.listeners)) {
			try {
				listener(event);
			} catch {
				// listeners must not throw into dispatcher
			}
		}
	}

	getLastAssistantText(): string {
		return this.lastAssistantText;
	}

	private async ensureClient(): Promise<AcpClient> {
		if (this.isDisposed) {
			throw new Error("OpencodeSubagentSession is already disposed");
		}
		if (this.client && this.client.isAlive() && this.sessionId) {
			return this.client;
		}
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			try {
				if (!this.client) {
					this.client = createOpencodeAcpClient({
						cwd: this.cwd,
						binaryPath: this.options.binaryPath,
						env: this.options.env,
						timeoutMs: this.options.timeoutMs,
					});
				}
				if (!this.client.isAlive()) {
					await this.client.start();
				}
				if (!this.sessionId) {
					const sessionId = await this.client.sessionNew(this.cwd);
					this.sessionId = sessionId;
				}
				return this.client;
			} finally {
				this.initPromise = null;
			}
		})();

		return this.initPromise;
	}

	async prompt(text: string): Promise<void> {
		if (this.isDisposed) {
			throw new Error("OpencodeSubagentSession is already disposed");
		}

		const runSinglePrompt = async (): Promise<void> => {
			if (this.isDisposed) {
				throw new Error("OpencodeSubagentSession is already disposed");
			}
			if (this.abortController.signal.aborted) {
				this.abortController = new AbortController();
			}

			const client = await this.ensureClient();
			const sessionId = this.sessionId!;

			this.emitEvent({ type: "turn_start" });

			try {
				const promptResult = await client.sessionPrompt(
					sessionId,
					text,
					(update) => {
						const updateType = (update as any).type ?? update.updateType;
						if (updateType === "chunk") {
							let chunkText = (update as any).text ?? (update as any).delta;
							if (!chunkText) {
								if (typeof update.content === "string") {
									chunkText = update.content;
								} else if (Array.isArray(update.content)) {
									chunkText = update.content
										.filter((c: any) => typeof c?.text === "string")
										.map((c: any) => c.text)
										.join("");
								} else if (typeof update.content?.text === "string") {
									chunkText = update.content.text;
								}
							}
							this.emitEvent({
								type: "message_delta",
								chunk: chunkText ?? "",
							});
						} else if (updateType === "tool_call") {
							this.emitEvent({
								type: "tool_execution_start",
								toolName: update.toolCall?.toolName ?? (update as any).toolName,
								args: update.toolCall?.toolArgs ?? (update as any).toolArgs,
							});
						} else if (updateType === "tool_result") {
							this.emitEvent({
								type: "tool_execution_end",
								toolName: update.toolCall?.toolName ?? (update as any).toolName,
								result: (update as any).result ?? update.content,
							});
						}
					},
					this.abortController.signal
				);

				this.lastAssistantText = promptResult.fullText;

				if (this.logPath) {
					try {
						const logDir = path.dirname(this.logPath);
						await fs.mkdir(logDir, { recursive: true });
						const timestamp = new Date().toISOString();
						const userEntry =
							JSON.stringify({
								type: "USER_INPUT",
								content: text,
								timestamp,
							}) + "\n";
						const assistantEntry =
							JSON.stringify({
								type: "PLANNER_RESPONSE",
								content: this.lastAssistantText,
								tool_calls: promptResult.toolCalls,
								timestamp,
							}) + "\n";
						await fs.appendFile(this.logPath, userEntry + assistantEntry, "utf-8");
					} catch {
						// log persistence errors must not abort the subagent run
					}
				}

				this.emitEvent({ type: "turn_end" });
				this.emitEvent({ type: "agent_end" });
			} catch (err) {
				this.emitEvent({ type: "turn_end" });
				this.emitEvent({ type: "agent_end" });
				throw err;
			}
		};

		const currentPromptPromise = this.promptQueue.catch(() => {}).then(runSinglePrompt);
		this.promptQueue = currentPromptPromise.catch(() => {});
		this.inFlightPrompt = this.promptQueue;
		await currentPromptPromise;
	}

	async waitForIdle(): Promise<void> {
		if (this.inFlightPrompt) {
			await this.inFlightPrompt.catch(() => {});
		}
	}

	async sendCustomMessage(msg: any): Promise<void> {
		if (typeof msg === "object" && msg?.content && typeof msg.content === "string") {
			await this.prompt(msg.content);
		}
	}

	async getDiff(): Promise<string> {
		try {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
				cwd: this.cwd,
				timeout: 5000,
			});
			return stdout;
		} catch {
			return "";
		}
	}

	async abort(): Promise<void> {
		this.abortController.abort();
		if (this.client && this.sessionId) {
			try {
				await this.client.sessionCancel(this.sessionId);
			} catch {
				// cancellation best effort
			}
		}
	}

	async dispose(): Promise<void> {
		if (this.isDisposed) return;
		this.isDisposed = true;
		await this.abort();
		if (this.inFlightPrompt) {
			await this.inFlightPrompt.catch(() => {});
		}
		if (this.client) {
			try {
				await this.client.stop();
			} catch {
				// cleanup best effort
			}
		}
		this.listeners.clear();
	}
}