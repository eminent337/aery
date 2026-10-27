/**
 * Sidecar Types & Specifications.
 *
 * Modeled after Google Antigravity (agy) Sidecars architecture.
 * Manages persistent background companion processes with restart policies,
 * log isolation, and health supervision.
 */

export type SidecarRestartPolicy = "always" | "on-failure" | "never";

export type SidecarStatus = "stopped" | "running" | "crashed" | "restarting";

export interface SidecarConfig {
	/** Unique identifier (directory or explicit ID) */
	id: string;
	/** Human-friendly display name */
	name?: string;
	displayName?: string;
	/** Brief description of what the sidecar does */
	description?: string;
	/** Executable or shell command */
	command: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables to inject */
	env?: Record<string, string>;
	/** Working directory for sidecar execution */
	cwd?: string;
	/** Restart behavior on process exit */
	restartPolicy?: SidecarRestartPolicy;
	/** Maximum restart attempts within backoff window (default: 5) */
	maxRestarts?: number;
}

export interface SidecarProcessInfo {
	id: string;
	name: string;
	pid?: number;
	status: SidecarStatus;
	uptimeSec: number;
	restartCount: number;
	startedAt?: number;
	lastError?: string;
	logPath: string;
	config: SidecarConfig;
}
