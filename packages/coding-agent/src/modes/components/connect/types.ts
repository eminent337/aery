export type PlatformId = "slack" | "telegram";

export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export interface BotInstance {
	id: string; // Token prefix or generated bot ID
	token: string;
	appToken?: string; // Slack only
	name?: string;
	status: ConnectionStatus;
	errorMessage?: string;
	connectedAt?: number;
}

export interface PlatformConfig {
	id: PlatformId;
	name: string;
	description: string;
	icon: string;
	mode: string;
	status: ConnectionStatus;
	errorMessage?: string;
	botTokens: string[];
	appToken?: string; // Slack only
	bots: BotInstance[];
}

export interface ConnectHubState {
	activeTab: "platforms" | "active";
	platforms: PlatformConfig[];
	selectedPlatform: PlatformConfig | null;
	isLoading: boolean;
	statusMessage?: string;
}
