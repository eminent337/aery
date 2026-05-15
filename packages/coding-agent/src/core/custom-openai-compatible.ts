import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID = "__custom-openai-compatible__";

const DEFAULT_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
};

const DEFAULT_MODEL_CONFIG = {
	reasoning: false,
	input: ["text"] as const,
	contextWindow: 128000,
	maxTokens: 16384,
};

type JsonObject = Record<string, unknown>;

export interface SaveCustomOpenAICompatibleProviderInput {
	modelsPath: string;
	baseUrl: string;
	modelId: string;
}

export interface SavedCustomOpenAICompatibleProvider {
	providerId: string;
	modelId: string;
	modelsPath: string;
}

function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

function isJsonObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLegacyBlankCustomOpenAICompatibleProvider(providerId: string, providerConfig: unknown): boolean {
	if (providerId !== "custom-openai-compatible" && providerId !== CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID) return false;
	if (!isJsonObject(providerConfig)) return false;
	if (providerConfig.baseUrl !== "") return false;
	if (providerConfig.api !== undefined && providerConfig.api !== "openai-completions") return false;
	const models = providerConfig.models;
	if (!Array.isArray(models) || models.length === 0) return false;
	return models.every((model) => isJsonObject(model) && typeof model.id === "string" && model.id.trim() === "");
}

function removeLegacyBlankCustomOpenAICompatibleProviders(providers: Record<string, unknown>): void {
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		if (isLegacyBlankCustomOpenAICompatibleProvider(providerId, providerConfig)) {
			delete providers[providerId];
		}
	}
}

function deriveProviderSeed(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		const path = url.pathname.replace(/\/+$/g, "");
		return `${url.hostname}${path ? `-${path}` : ""}`;
	} catch {
		return baseUrl;
	}
}

function loadModelsConfig(modelsPath: string): JsonObject {
	if (!existsSync(modelsPath)) return { providers: {} };

	try {
		const content = readFileSync(modelsPath, "utf-8").trim();
		if (!content) return { providers: {} };
		const parsed = JSON.parse(stripJsonComments(content)) as JsonObject;
		if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
			return { ...parsed, providers: {} };
		}
		return parsed;
	} catch (error) {
		throw new Error(`Failed to parse models.json: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function getProviderIdForBaseUrl(existingProviders: Record<string, unknown>, baseUrl: string): string {
	for (const [providerId, providerValue] of Object.entries(existingProviders)) {
		if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
		const provider = providerValue as { baseUrl?: unknown; api?: unknown };
		if (provider.baseUrl === baseUrl && provider.api === "openai-completions") {
			return providerId;
		}
	}

	const baseSlug = slugify(deriveProviderSeed(baseUrl)) || "openai-compatible";
	const candidateBase = `custom-${baseSlug}`;
	let candidate = candidateBase;
	let suffix = 2;
	while (existingProviders[candidate] !== undefined) {
		candidate = `${candidateBase}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}

export function saveCustomOpenAICompatibleProvider(
	input: SaveCustomOpenAICompatibleProviderInput,
): SavedCustomOpenAICompatibleProvider {
	const baseUrl = input.baseUrl.trim().replace(/\/+$/g, "");
	const modelId = input.modelId.trim();
	if (!baseUrl) throw new Error("Base URL cannot be empty.");
	if (!modelId) throw new Error("Model ID cannot be empty.");

	const config = loadModelsConfig(input.modelsPath);
	const providers = config.providers as Record<string, unknown>;
	removeLegacyBlankCustomOpenAICompatibleProviders(providers);
	const providerId = getProviderIdForBaseUrl(providers, baseUrl);

	providers[providerId] = {
		baseUrl,
		api: "openai-completions",
		compat: DEFAULT_COMPAT,
		models: [
			{
				id: modelId,
				name: modelId,
				...DEFAULT_MODEL_CONFIG,
			},
		],
	};

	mkdirSync(dirname(input.modelsPath), { recursive: true, mode: 0o700 });
	writeFileSync(input.modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

	return {
		providerId,
		modelId,
		modelsPath: input.modelsPath,
	};
}
