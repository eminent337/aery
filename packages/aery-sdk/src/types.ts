// ─── Core Primitive Types ─────────────────────────────────────────────────────

/** Log severity level for extension-emitted messages */
export type LogLevel = "info" | "warning" | "error" | "debug";

/** The return value of any tool execution */
export type ToolResult = {
	/** The text content to return to the agent */
	content: string;
	/** When true, the content describes an error that occurred */
	isError?: boolean;
};

/** The result of a shell command executed via ExtensionAPI.exec() */
export type ExecResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

/** Valid source file loader types (Bun-aligned) */
export type LoaderType = "js" | "jsx" | "ts" | "tsx";
