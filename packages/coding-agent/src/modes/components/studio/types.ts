/**
 * Type definitions for Aery Studio (/studio) multi-agent visual war-room overlay.
 */

export type StudioTab = "swarm" | "chat" | "inspector";

export interface StudioAgentNode {
	id: string;
	displayName: string;
	kind: string;
	status: "running" | "idle" | "parked" | "completed" | "failed";
	parentId?: string;
	currentTool?: string;
	currentToolArgs?: string;
	assignment?: string;
	tokens: number;
	durationMs: number;
	unreadCount: number;
	lastActiveAt: number;
}

export interface StudioChatMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	timestamp: number;
	replyTo?: string;
	isBroadcast?: boolean;
}

export interface StudioInspectorDiff {
	filePath: string;
	patchContent?: string;
	authorAgentId: string;
	timestamp: number;
}

export interface StudioState {
	activeTab: StudioTab;
	activeAgentId?: string;
	agents: StudioAgentNode[];
	chatMessages: StudioChatMessage[];
	diffs: StudioInspectorDiff[];
	consensusAgreedCount: number;
	consensusTotalCount: number;
	isLiveSwarmActive: boolean;
	statusMessage?: string;
}
