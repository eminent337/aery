export type MemberState = "waiting" | "working" | "paused" | "stopped" | "killed";

export type WorkspaceMode = "inherit" | "share" | "branch";

export interface SwarmMember {
	name: string;
	brief: string;
	model?: string;
	state: MemberState;
	workspace: WorkspaceMode;
	workspacePath?: string;
	branchName?: string;
	lastSeqRead: number;
	createdAt: string;
	updatedAt?: string;
}

export interface BoardMessage {
	seq: number;
	timestamp: string;
	from: string;
	channel?: string;
	mentions: string[];
	content: string;
}

export interface SwarmConfig {
	swarmId: string;
	storageDir: string;
	coordinatorModel?: string;
	defaultWorkerModel?: string;
}
