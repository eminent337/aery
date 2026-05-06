import { join } from "node:path";
import { getDocsPath } from "../config.js";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderSetupRequirements(provider: string): string[] {
	if (provider === "cloudflare-workers-ai") {
		return [
			"Cloudflare Workers AI requires a Cloudflare API token.",
			"It also requires a Cloudflare account ID, saved during /login or set as CLOUDFLARE_ACCOUNT_ID.",
		];
	}
	return [];
}

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	const setupRequirements = getProviderSetupRequirements(provider);
	const providerSpecificHelp =
		setupRequirements.length > 0 ? `\n\n${setupRequirements.map((line) => `- ${line}`).join("\n")}` : "";
	return `No API key found for ${providerDisplay}.${providerSpecificHelp}\n\n${getProviderLoginHelp()}`;
}
