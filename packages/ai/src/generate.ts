import { complete, stream } from "./stream";
import type {
	Api,
	AssistantMessage,
	Context,
	GenerateFunction,
	GenerateOptionsUnified,
	GenerateStream,
	KnownProvider,
	Model,
} from "./types";
import type { AssistantMessageEventStream } from "./utils/event-stream";

export class QueuedGenerateStream implements GenerateStream {
	private inner: AssistantMessageEventStream;
	constructor(inner: AssistantMessageEventStream) {
		this.inner = inner;
	}

	async *[Symbol.asyncIterator]() {
		yield* this.inner;
	}

	finalMessage(): Promise<AssistantMessage> {
		return this.inner.result();
	}
}

export function generate(model: Model<Api>, context: Context, options?: GenerateOptionsUnified): GenerateStream {
	// Map reasoning effort back to Aery's stream API seamlessly
	return new QueuedGenerateStream(stream(model, context, options as any));
}

export async function generateComplete(
	model: Model<Api>,
	context: Context,
	options?: GenerateOptionsUnified,
): Promise<AssistantMessage> {
	return complete(model, context, options as any);
}

const apiImplementations: Map<Api | string, GenerateFunction<any>> = new Map();
export function registerApi(api: string, impl: GenerateFunction<any>): void {
	apiImplementations.set(api, impl);
}

// API key storage
const apiKeys: Map<string, string> = new Map();

export function setApiKey(provider: KnownProvider, key: string): void;
export function setApiKey(provider: string, key: string): void;
export function setApiKey(provider: any, key: string): void {
	apiKeys.set(provider, key);
}

export function getApiKey(provider: KnownProvider): string | undefined;
export function getApiKey(provider: string): string | undefined;
export function getApiKey(provider: any): string | undefined {
	const key = apiKeys.get(provider);
	if (key) return key;

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GEMINI_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};
	const envVar = envMap[provider];
	return envVar ? process.env[envVar] : undefined;
}
