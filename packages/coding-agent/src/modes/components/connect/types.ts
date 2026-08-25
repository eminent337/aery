export type PlatformId = "slack" | "telegram";

export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export interface PlatformConfig {
	id: PlatformId;
	name: string;
	description: string;
	icon: string;
	mode: string;
	status: ConnectionStatus;
	errorMessage?: string;
	botToken?: string;
	appToken?: string; // Slack only
}

export interface ConnectHubState {
	activeTab: "platforms" | "active";
	platforms: PlatformConfig[];
	selectedPlatform: PlatformConfig | null;
	isLoading: boolean;
	statusMessage?: string;
}
