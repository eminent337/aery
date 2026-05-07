import type { Api, Model } from "@eminent337/aery-ai";
import type { AuthStatus } from "./auth-storage.js";

export type ProviderSetupCheckLevel = "ok" | "warning" | "error";

export type ProviderSetupCheckResult = {
	level: ProviderSetupCheckLevel;
	message: string;
};

type ProviderSetupRegistry = {
	getProviderAuthStatus(provider: string): AuthStatus;
	getAvailable(): Model<Api>[];
};

export function checkProviderSetup(
	providerId: string,
	providerName: string,
	modelRegistry: ProviderSetupRegistry,
): ProviderSetupCheckResult {
	const authStatus = modelRegistry.getProviderAuthStatus(providerId);
	if (!authStatus.configured) {
		const reason = authStatus.label ?? "credentials are not configured";
		return {
			level: "error",
			message: `Provider check failed for ${providerName}: ${reason}.`,
		};
	}

	const providerModels = modelRegistry.getAvailable().filter((model) => model.provider === providerId);
	if (providerModels.length === 0) {
		return {
			level: "warning",
			message: `Provider check could not find available ${providerName} models. Use /model to select or add a model.`,
		};
	}

	return {
		level: "ok",
		message: `Provider check passed for ${providerName}: ${providerModels.length} ${
			providerModels.length === 1 ? "model" : "models"
		} available.`,
	};
}
