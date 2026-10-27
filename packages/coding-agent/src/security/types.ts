/**
 * PolicyGuardian Types — Security and Pre-Execution Policy Engine.
 *
 * Ported from Google Antigravity (agy).
 */

export interface PolicyCheckResult {
	allowed: boolean;
	ruleName?: string;
	reason?: string;
	violationDetails?: {
		matchedPattern?: string;
		target?: string;
		suggestion?: string;
	};
}

export interface PolicyGuardianConfig {
	enabled?: boolean;
	blockEnvCommits?: boolean;
	blockSystemDeletion?: boolean;
	blockForcePush?: boolean;
	blockClusterMutations?: boolean;
	blockBroadProcessKill?: boolean;
}
