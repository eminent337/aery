/**
 * PolicyGuardian — Pre-Execution Deterministic Safety Engine.
 *
 * Ported from Google Antigravity (agy). Inspects terminal commands and actions
 * before OS execution to intercept credentials leakage, destructive filesystem
 * deletion, live cluster mutations, and unauthorized force pushes.
 */

import type { PolicyCheckResult, PolicyGuardianConfig } from "./types";

// Regex matching git add / git commit targeting .env files (from agy reverse engineering)
const ENV_COMMIT_REGEX =
	/\bgit\s+(?:add|commit)\b[^\n;&|]*(?:^|\s|["'/\\])[\w.-]*\.env(?:\.[a-z0-9_-]+)?(?:[\s"';&|]|$)/i;

// Recursive deletion targeting root or critical system directories
const SYSTEM_DELETION_REGEX =
	/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)(?:-[a-zA-Z]*\s+)*(?:\/|\/etc|\/usr|\/bin|\/sbin|\/lib|\/lib64|\/boot|\/var|\/home|~)(?:\/|\s|$)/i;

// Force push regex (matches --force or -f in git push)
const GIT_PUSH_REGEX = /\bgit\s+push\b/i;
const FORCE_FLAG_REGEX = /(?:--force|-f\b)/i;
const PROTECTED_BRANCH_REGEX = /\b(?:main|master|release|prod|production)\b/i;

// Live Kubernetes / Helm cluster mutations without dry-run
const K8S_MUTATION_REGEX = /\b(?:kubectl\s+(?:delete|patch|replace)|helm\s+(?:uninstall|delete))\b/i;

// Blanket process termination across host
const BROAD_KILL_REGEX = /\b(?:killall\b|pkill\s+(?:-[a-zA-Z0-9]+\s+)*[a-zA-Z]|Stop-Process\s+-Name\b)/i;

export class PolicyGuardian {
	private readonly config: Required<PolicyGuardianConfig>;

	constructor(config?: PolicyGuardianConfig) {
		this.config = {
			enabled: config?.enabled ?? true,
			blockEnvCommits: config?.blockEnvCommits ?? true,
			blockSystemDeletion: config?.blockSystemDeletion ?? true,
			blockForcePush: config?.blockForcePush ?? true,
			blockClusterMutations: config?.blockClusterMutations ?? true,
			blockBroadProcessKill: config?.blockBroadProcessKill ?? true,
		};
	}

	/**
	 * Inspect a command line string against deterministic security policies.
	 */
	validate(command: string): PolicyCheckResult {
		if (!this.config.enabled || !command || !command.trim()) {
			return { allowed: true };
		}

		const cleanCmd = command.trim();

		// 1. Check for .env and credential commit leakage
		if (this.config.blockEnvCommits && ENV_COMMIT_REGEX.test(cleanCmd)) {
			return {
				allowed: false,
				ruleName: "vet_credential_leak",
				reason:
					"[PolicyGuardian] Action denied: Staging or committing .env files is prohibited to prevent leaking secrets.",
				violationDetails: {
					matchedPattern: "git add/commit .env",
					suggestion: "Add .env to .gitignore and use example environment templates (.env.example).",
				},
			};
		}

		// 2. Check for irreversible system filesystem deletion
		if (this.config.blockSystemDeletion && SYSTEM_DELETION_REGEX.test(cleanCmd)) {
			return {
				allowed: false,
				ruleName: "vet_system_destruction",
				reason:
					"[PolicyGuardian] Action denied: Recursive deletion under core system or home root paths is prohibited.",
				violationDetails: {
					matchedPattern: "rm -r on system root",
					suggestion: "Limit deletions to specific project subdirectories.",
				},
			};
		}

		// 3. Check for unconfirmed force push to protected branches
		if (
			this.config.blockForcePush &&
			GIT_PUSH_REGEX.test(cleanCmd) &&
			FORCE_FLAG_REGEX.test(cleanCmd) &&
			PROTECTED_BRANCH_REGEX.test(cleanCmd)
		) {
			return {
				allowed: false,
				ruleName: "vet_irreversible_push",
				reason:
					"[PolicyGuardian] Action denied: Force-pushing to protected branches (main/master/release) requires explicit operator intent.",
				violationDetails: {
					matchedPattern: "git push --force to protected branch",
					suggestion: "Use normal git push, push to a feature branch, or obtain explicit confirmation.",
				},
			};
		}

		// 4. Check for live Kubernetes cluster mutations without dry run
		if (this.config.blockClusterMutations && K8S_MUTATION_REGEX.test(cleanCmd) && !cleanCmd.includes("--dry-run")) {
			return {
				allowed: false,
				ruleName: "vet_cluster_mutation",
				reason:
					"[PolicyGuardian] Action denied: Mutating or deleting live cluster workloads is restricted. Pass --dry-run=client/server or request review.",
				violationDetails: {
					matchedPattern: "kubectl delete/patch or helm uninstall without dry-run",
					suggestion: "Verify workloads with kubectl get/describe first, or run with --dry-run=client.",
				},
			};
		}

		// 5. Check for broad host process termination
		if (this.config.blockBroadProcessKill && BROAD_KILL_REGEX.test(cleanCmd)) {
			return {
				allowed: false,
				ruleName: "vet_broad_kill",
				reason:
					"[PolicyGuardian] Action denied: Blanket process killing (killall/pkill -9) can terminate user applications. Target specific agent PIDs.",
				violationDetails: {
					matchedPattern: "blanket process kill",
					suggestion:
						"Kill specific process IDs using 'kill <pid>' instead of killing all matching process names.",
				},
			};
		}

		return { allowed: true };
	}
}

let defaultGuardianInstance: PolicyGuardian | undefined;

export function getDefaultPolicyGuardian(): PolicyGuardian {
	if (!defaultGuardianInstance) {
		defaultGuardianInstance = new PolicyGuardian();
	}
	return defaultGuardianInstance;
}
