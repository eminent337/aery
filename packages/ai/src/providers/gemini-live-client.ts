/**
 * Google Gemini Multimodal Live Client.
 *
 * Implements bidirectional real-time streaming over WebSocket:
 * - Sends streaming audio (PCM 16kHz) and zero-disk screen frames (JPEG).
 * - Receives real-time streaming model speech (PCM 24kHz) and text.
 * - Handles real-time tool calls (e.g. computer_use, shell).
 */

import { EventEmitter } from "node:events";
import type {
	BidiClientMessage,
	BidiServerMessage,
	BidiSetupConfig,
	RealtimeMediaChunk,
} from "./gemini-live-types";
import type { FunctionResponsePart } from "./google-types";

export interface GeminiLiveClientOptions {
	apiKey: string;
	model?: string;
	host?: string;
	setupConfig?: Partial<BidiSetupConfig>;
}

export class GeminiLiveClient extends EventEmitter {
	private ws?: WebSocket;
	private apiKey: string;
	private model: string;
	private host: string;
	private setupConfig?: Partial<BidiSetupConfig>;
	private connected = false;
	private isSetupComplete = false;

	constructor(options: GeminiLiveClientOptions) {
		super();
		this.apiKey = options.apiKey;
		this.model = options.model ?? "gemini-2.0-flash-exp";
		this.host =
			options.host ??
			"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
		this.setupConfig = options.setupConfig;
	}

	/** Connect to the Gemini Live WebSocket endpoint and send setup. */
	async connect(): Promise<void> {
		if (this.connected) return;

		const url = `${this.host}?key=${this.apiKey}`;
		this.ws = new WebSocket(url);

		return new Promise((resolve, reject) => {
			if (!this.ws) return reject(new Error("WebSocket initialization failed"));

			this.ws.onopen = () => {
				this.connected = true;
				this.emit("open");
				this.sendSetup();
				resolve();
			};

			this.ws.onerror = (err) => {
				this.emit("error", err);
				if (!this.connected) reject(err);
			};

			this.ws.onclose = (event) => {
				this.connected = false;
				this.isSetupComplete = false;
				this.emit("close", event);
			};

			this.ws.onmessage = (event) => {
				this.handleMessage(event.data);
			};
		});
	}

	/** Send a real-time media chunk (audio or image). */
	sendRealtimeMedia(chunk: RealtimeMediaChunk): void {
		if (!this.connected || !this.ws) {
			throw new Error("Cannot send media chunk: GeminiLiveClient is not connected");
		}

		const msg: BidiClientMessage = {
			realtimeInput: {
				mediaChunks: [chunk],
			},
		};

		this.sendMessage(msg);
	}

	/** Send tool call responses back to Gemini. */
	sendToolResponse(responses: FunctionResponsePart[]): void {
		if (!this.connected || !this.ws) {
			throw new Error("Cannot send tool response: GeminiLiveClient is not connected");
		}

		const msg: BidiClientMessage = {
			toolResponse: {
				functionResponses: responses,
			},
		};

		this.sendMessage(msg);
	}

	/** Disconnect cleanly. */
	disconnect(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = undefined;
		}
		this.connected = false;
		this.isSetupComplete = false;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get ready(): boolean {
		return this.connected && this.isSetupComplete;
	}

	private sendSetup(): void {
		const setupMsg: BidiClientMessage = {
			setup: {
				model: `models/${this.model.replace(/^models\//, "")}`,
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: {
								voiceName: "Aoede",
							},
						},
					},
					...this.setupConfig?.generationConfig,
				},
				systemInstruction: this.setupConfig?.systemInstruction,
				tools: this.setupConfig?.tools,
			},
		};

		this.sendMessage(setupMsg);
	}

	private sendMessage(msg: BidiClientMessage): void {
		if (this.ws && this.connected) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private handleMessage(data: unknown): void {
		try {
			const str = typeof data === "string" ? data : data?.toString?.() ?? "";
			if (!str) return;

			const parsed = JSON.parse(str) as BidiServerMessage;

			if ("setupComplete" in parsed) {
				this.isSetupComplete = true;
				this.emit("setupComplete", parsed.setupComplete);
			} else if ("serverContent" in parsed) {
				const sc = parsed.serverContent;
				if (sc.modelTurn?.parts) {
					for (const part of sc.modelTurn.parts) {
						if (part.text) {
							this.emit("text", part.text);
						}
						if (part.inlineData && part.inlineData.mimeType.startsWith("audio/")) {
							this.emit("audio", part.inlineData.data);
						}
					}
				}
				if (sc.interrupted) {
					this.emit("interrupted");
				}
				if (sc.turnComplete) {
					this.emit("turnComplete");
				}
			} else if ("toolCall" in parsed) {
				this.emit("toolCall", parsed.toolCall.functionCalls);
			} else if ("toolCallCancellation" in parsed) {
				this.emit("toolCallCancellation", parsed.toolCallCancellation.ids);
			}
		} catch (err) {
			this.emit("error", err);
		}
	}
}
