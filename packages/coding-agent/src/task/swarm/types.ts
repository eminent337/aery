export interface SwarmTask {
	id: string;
	agent: string;
	assignment: string;
	needs?: string[];
	maxRetries?: number;
	timeout?: number;
	retryDelay?: number;
}

export interface SwarmWorkflow {
	name: string;
	tasks: SwarmTask[];
	maxConcurrency?: number;
}

export interface TaskState {
	id: string;
	status: "pending" | "running" | "completed" | "failed" | "retrying" | "blocked";
	attempts: number;
	maxRetries: number;
	error?: string;
}
