/**
 * Fine-Grained Permissions & Workspace Trust Types.
 *
 * Modeled after Google Antigravity (agy) permissions & workspace trust architecture.
 */

export type PermissionAction = "command" | "file_read" | "file_write" | "mcp" | "url";

export interface ParsedPermissionRule {
	raw: string;
	action: PermissionAction;
	pattern: string;
	effect: "allow" | "deny";
}

export interface PermissionsConfig {
	allow?: string[];
	deny?: string[];
}

export interface WorkspaceTrustConfig {
	trustedWorkspaces?: string[];
	allowNonWorkspaceAccess?: boolean;
	permissions?: PermissionsConfig;
}

export interface PermissionEvaluationResult {
	allowed: boolean;
	reason?: string;
	matchedRule?: ParsedPermissionRule;
}
