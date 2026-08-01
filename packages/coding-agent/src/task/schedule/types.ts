export interface ScheduledRun {
	id: string;
	name: string;
	cronPattern: string;
	prompt: string;
	agent?: string;
	enabled: boolean;
	createdAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
}
