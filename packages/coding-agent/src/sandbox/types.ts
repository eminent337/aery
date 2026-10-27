/**
 * Sandbox configuration and interface types for Aery.
 */

export interface SandboxConfig {
	enabled: boolean;
	workspaceDir: string;
	allowNetwork?: boolean;
	additionalReadWritePaths?: string[];
	additionalReadOnlyPaths?: string[];
	shadowSensitivePaths?: boolean;
}

export interface SandboxProbeResult {
	available: boolean;
	backend: "bwrap" | "none";
	path?: string;
	reason?: string;
}
