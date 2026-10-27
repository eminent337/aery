/**
 * Interactive Web Hub Types.
 */

export interface HubConfig {
	port: number;
	host: string;
	cwd: string;
}

export interface HubEventMessage {
	type: "agent_update" | "sidecar_update" | "battle_update" | "voice_stream" | "log";
	payload: unknown;
	timestamp: number;
}
