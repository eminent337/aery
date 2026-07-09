export interface SwarmTask {
	id: string;
	agent: string;
	assignment: string;
	needs?: string[];
}

export interface SwarmWorkflow {
	name: string;
	tasks: SwarmTask[];
	maxConcurrency?: number;
}
