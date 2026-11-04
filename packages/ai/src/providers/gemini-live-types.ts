/**
 * Google Gemini Multimodal Live API (BidiGenerateContent) WebSocket Wire Types.
 *
 * Models the bidirectional WebSocket streaming protocol used for low-latency
 * audio, vision, and tool interaction:
 *   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent
 */

import type { Content, FunctionCallPart, FunctionResponsePart, ToolDeclaration } from "./google-types";

// ==========================================
// Setup & Configuration Types
// ==========================================

export type LiveVoiceName =
	| "Puck"
	| "Charon"
	| "Kore"
	| "Fenrir"
	| "Aoede"
	| "Leda"
	| "Orpheus"
	| "Zephyr";

export interface SpeechConfig {
	voiceConfig?: {
		prebuiltVoiceConfig?: {
			voiceName?: LiveVoiceName | string;
		};
	};
}

export interface LiveGenerationConfig {
	responseModalities?: Array<"TEXT" | "AUDIO" | "IMAGE">;
	speechConfig?: SpeechConfig;
	temperature?: number;
	topP?: number;
	topK?: number;
	maxOutputTokens?: number;
	candidateCount?: number;
}

export interface BidiSetupConfig {
	model: string;
	generationConfig?: LiveGenerationConfig;
	systemInstruction?: Content | { role?: string; parts: { text: string }[] };
	tools?: ToolDeclaration[];
}

export interface BidiSetupMessage {
	setup: BidiSetupConfig;
}

// ==========================================
// Real-time Input Types (Client -> Server)
// ==========================================

export interface RealtimeMediaChunk {
	mimeType: "image/jpeg" | "image/webp" | "image/png" | "audio/pcm;rate=16000" | string;
	/** Base64-encoded binary payload */
	data: string;
}

export interface BidiRealtimeInputMessage {
	realtimeInput: {
		mediaChunks: RealtimeMediaChunk[];
	};
}

export interface BidiClientContentMessage {
	clientContent: {
		turns: Content[];
		turnComplete?: boolean;
	};
}

export interface BidiToolResponseMessage {
	toolResponse: {
		functionResponses: FunctionResponsePart[];
	};
}

/** Union of all messages sent from client to server */
export type BidiClientMessage =
	| BidiSetupMessage
	| BidiRealtimeInputMessage
	| BidiClientContentMessage
	| BidiToolResponseMessage;

// ==========================================
// Server Response Types (Server -> Client)
// ==========================================

export interface BidiSetupCompleteMessage {
	setupComplete: Record<string, unknown>;
}

export interface BidiServerContentMessage {
	serverContent: {
		modelTurn?: {
			parts: Array<{
				text?: string;
				thought?: boolean;
				inlineData?: {
					mimeType: string;
					data: string; // Base64 PCM audio or image
				};
			}>;
		};
		turnComplete?: boolean;
		interrupted?: boolean;
	};
}

export interface BidiToolCallMessage {
	toolCall: {
		functionCalls: FunctionCallPart[];
	};
}

export interface BidiToolCallCancellationMessage {
	toolCallCancellation: {
		ids: string[];
	};
}

/** Union of all messages sent from server to client */
export type BidiServerMessage =
	| BidiSetupCompleteMessage
	| BidiServerContentMessage
	| BidiToolCallMessage
	| BidiToolCallCancellationMessage;
