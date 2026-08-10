import type { ModelManagerOptions } from "../model-manager";

export interface KiroModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	kiroPath?: string;
}

export function kiroModelManagerOptions(_config?: KiroModelManagerConfig): ModelManagerOptions<"kiro-cli"> {
	return {
		providerId: "kiro",
	};
}
