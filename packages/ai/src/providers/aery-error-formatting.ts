/**
 * Aery-specific error formatting for OpenAI-compatible providers.
 * Extracted here so upstream syncs to openai-completions.ts do not overwrite
 * these actionable error messages.
 */

import type { Model } from "../types.js";
import { isCloudflareProvider } from "./cloudflare.js";

export function extractProviderErrorDetails(error: unknown): {
	status?: number;
	code?: string | number;
	message?: string;
} {
	const errorAny = error as {
		status?: number;
		code?: string | number;
		message?: string;
		error?: {
			code?: string | number;
			message?: string;
			errors?: Array<{ code?: string | number; message?: string }>;
		};
	};
	const providerError = errorAny?.error;
	const firstNestedError = Array.isArray(providerError?.errors) ? providerError.errors[0] : undefined;

	return {
		status: errorAny?.status,
		code: firstNestedError?.code ?? providerError?.code ?? errorAny?.code,
		message: firstNestedError?.message ?? providerError?.message ?? errorAny?.message,
	};
}

function isAuthErrorCode(code: string | number | undefined): boolean {
	if (code === undefined) return false;
	return ["invalid_api_key", "unauthorized", "forbidden", "authentication_error"].includes(String(code).toLowerCase());
}

function isCloudflareError(error: unknown, model: Model<"openai-completions">): boolean {
	const errorAny = error as { headers?: Record<string, string>; message?: string };
	const message = errorAny?.message || "";
	return (
		isCloudflareProvider(model.provider) ||
		model.baseUrl.includes("api.cloudflare.com") ||
		message.includes("Cloudflare") ||
		message.includes("Workers AI")
	);
}

function isCloudflareQuotaError(details: { status?: number; code?: string | number; message?: string }): boolean {
	const message = (details.message || "").toLowerCase();
	return (
		details.status === 429 &&
		(details.code === 4006 ||
			details.code === "4006" ||
			message.includes("daily free allocation") ||
			message.includes("used up") ||
			message.includes("neurons"))
	);
}

function formatProviderName(provider: string): string {
	const names: Record<string, string> = {
		"azure-openai-responses": "Azure OpenAI Responses",
		cerebras: "Cerebras",
		fireworks: "Fireworks",
		groq: "Groq",
		huggingface: "Hugging Face",
		"kimi-coding": "Kimi For Coding",
		mistral: "Mistral",
		minimax: "MiniMax",
		"minimax-cn": "MiniMax (China)",
		opencode: "OpenCode Zen",
		"opencode-go": "OpenCode Go",
		openai: "OpenAI",
		openrouter: "OpenRouter",
		"vercel-ai-gateway": "Vercel AI Gateway",
		xai: "xAI",
		zai: "ZAI",
	};
	return names[provider] ?? provider;
}

function formatGenericOpenAICompatibleError(
	details: { status?: number; code?: string | number; message?: string },
	model: Model<"openai-completions">,
	fallback: string,
): string | undefined {
	const providerName = formatProviderName(model.provider);
	const providerError = details.message || fallback;

	if (details.status === 401 || details.status === 403 || isAuthErrorCode(details.code)) {
		return [
			`${providerName} authentication failed: check the API key and provider access for this model.`,
			`Provider error: ${providerError}`,
		].join("\n");
	}

	if (details.status === 402) {
		return [
			`${providerName} quota or billing limit reached: check credits, billing, or plan limits.`,
			`Provider error: ${providerError}`,
		].join("\n");
	}

	if (details.status === 429) {
		return [
			`${providerName} rate limit reached or quota exhausted: wait and retry, reduce request rate, or check plan limits.`,
			`Provider error: ${providerError}`,
		].join("\n");
	}

	if (details.status && details.status >= 500) {
		return [
			`${providerName} is temporarily unavailable or returned a server error.`,
			"Retry later or switch to another provider/model.",
			`Provider error: ${providerError}`,
		].join("\n");
	}

	return undefined;
}

export function formatOpenAICompletionsError(error: unknown, model: Model<"openai-completions">): string {
	const fallback = error instanceof Error ? error.message : JSON.stringify(error);
	const details = extractProviderErrorDetails(error);

	if (!isCloudflareError(error, model)) {
		return formatGenericOpenAICompatibleError(details, model, fallback) ?? fallback;
	}

	if (isCloudflareQuotaError(details)) {
		return [
			"Cloudflare Workers AI quota exhausted: the daily free allocation has been used.",
			"Upgrade Cloudflare Workers AI to a paid plan or wait for the daily allocation reset.",
			`Provider error: ${details.message || fallback}`,
		].join("\n");
	}

	if (details.status === 429) {
		return [
			"Cloudflare Workers AI quota exhausted or rate limit reached.",
			"If the daily free allocation is used up, upgrade Cloudflare Workers AI to a paid plan or wait for the daily allocation reset.",
			`Provider error: ${details.message || fallback}`,
		].join("\n");
	}

	return fallback;
}
