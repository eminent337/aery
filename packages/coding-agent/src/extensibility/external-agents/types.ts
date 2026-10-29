/**
 * Types for Universal External Agent Bridge
 */

export interface ExternalAgentExecutionOptions {
	cwd?: string;
	background?: boolean;
	extraArgs?: string[];
	customBinary?: string;
	timeoutMs?: number;
}

export interface ResolvedAgentInvocation {
	binary: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface ExternalAgentAdapter {
	id: string;
	displayName: string;
	defaultBinary: string;
	versionArgs: string[];
	buildArgs: (prompt: string, options?: ExternalAgentExecutionOptions) => string[];
	parseVersion?: (stdout: string) => string;
}

export interface DiscoveredExternalAgent {
	id: string;
	displayName: string;
	binaryPath: string;
	installed: boolean;
	version?: string;
}
