/**
 * Declarative Lifecycle Hooks Types.
 *
 * Modeled after Google Antigravity (agy) hooks.json specification.
 * Allows repository and global hooks to execute commands at key agent lifecycle stages.
 */

export interface HookHandlerConfig {
	type?: "command";
	/** Shell command or script path to execute */
	command: string;
	/** Timeout in seconds (default: 15) */
	timeout?: number;
}

export interface GroupedHookConfig {
	/** Tool name matcher pattern (e.g. "bash", "run_command", "edit*", "*") */
	matcher: string;
	/** List of hook handlers to execute */
	hooks: HookHandlerConfig[];
}

export interface DeclarativeHookDef {
	/** Whether this hook definition is active (default: true) */
	enabled?: boolean;
	/** Handlers running once on session start */
	SessionStart?: HookHandlerConfig[];
	/** Handlers running before a tool executes; non-zero exit aborts tool */
	PreToolUse?: GroupedHookConfig[];
	/** Handlers running after a tool executes */
	PostToolUse?: GroupedHookConfig[];
	/** Handlers running before model invocation */
	PreInvocation?: HookHandlerConfig[];
	/** Handlers running after turn completes */
	PostInvocation?: HookHandlerConfig[];
	/** Handlers running on session teardown */
	Stop?: HookHandlerConfig[];
}

export type HooksJsonFile = Record<string, DeclarativeHookDef>;

export interface HookExecResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface PreToolGateResult {
	allowed: boolean;
	reason?: string;
	stdout?: string;
	stderr?: string;
}

export interface PostToolGateResult {
	warnings: string[];
	stdout?: string;
	stderr?: string;
}
