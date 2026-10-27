/**
 * Autonomous Self-Healing Engine Types.
 */

export interface HealingResult {
	success: boolean;
	attempts: number;
	command: string;
	initialError: string;
	repairedDiff?: string;
	applied: boolean;
	summary?: string;
}

export interface HealerOptions {
	maxAttempts?: number;
	autoApply?: boolean;
	cwd?: string;
	timeoutMs?: number;
}
