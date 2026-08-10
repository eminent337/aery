import type { ModelManagerOptions } from "../model-manager";

export interface AutoRouterModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	enabled?: boolean;
}

export function autoRouterModelManagerOptions(
	_config?: AutoRouterModelManagerConfig,
): ModelManagerOptions<"auto-router"> {
	return {
		providerId: "aery",
	};
}
