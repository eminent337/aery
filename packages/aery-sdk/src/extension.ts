// ─── Extension API ────────────────────────────────────────────────────────────

import type { AeryEventHandler, AeryEventName } from "./events";
import type { AeryTool } from "./tools";
import type { ExecResult } from "./types";

/** A slash-command registration descriptor */
export interface AeryCommandHandler {
	/** Short description shown in /help listings */
	description: string;
	/** Function invoked when the user runs the command. Receives the raw argument string. */
	handler: (args: string) => void | Promise<void>;
}

/**
 * The primary API surface injected into every Aery extension at load time.
 *
 * @example
 * export default async function myExtension(api: ExtensionAPI) {
 *   api.on("session_start", () => api.sendUserMessage("👋 MyExtension loaded!"));
 *   api.registerTool(myTool);
 * }
 */
export interface ExtensionAPI {
	// ── Commands ──────────────────────────────────────────────────────────────

	/**
	 * Register a slash-command (e.g. `/marketplace`).
	 * The name should be provided **without** the leading slash.
	 */
	registerCommand(name: string, handler: AeryCommandHandler): void;

	// ── Tools ─────────────────────────────────────────────────────────────────

	/**
	 * Register a tool that the agent can invoke during its reasoning loop.
	 * Tools registered here appear in the agent's tool palette.
	 */
	registerTool(tool: AeryTool): void;

	// ── Events ────────────────────────────────────────────────────────────────

	/**
	 * Subscribe to an Aery lifecycle event.
	 * Multiple handlers can be registered for the same event.
	 */
	on(event: AeryEventName, handler: AeryEventHandler): void;

	// ── Messaging ─────────────────────────────────────────────────────────────

	/**
	 * Inject a message into the user's chat thread.
	 * Useful for status updates, alerts, or extension-generated content.
	 */
	sendUserMessage(message: string): void;

	// ── Shell ─────────────────────────────────────────────────────────────────

	/**
	 * Execute a shell command and return its output.
	 *
	 * @param cmd  - The executable to run
	 * @param args - Arguments passed to the executable
	 * @param opts - Optional timeout (ms) and working directory
	 */
	exec(cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }): Promise<ExecResult>;

	// ── Metadata ──────────────────────────────────────────────────────────────

	/** The unique ID of the current session */
	readonly sessionId: string;

	/** The name of this extension as declared in its manifest */
	readonly extensionName: string;
}

/**
 * The required export type for any Aery extension entry point.
 *
 * Your extension module must have a **default export** of this type:
 *
 * @example
 * // my-extension/index.ts
 * import type { AeryExtension } from "@aryee337/aery-sdk";
 *
 * const extension: AeryExtension = async (api) => {
 *   api.on("session_start", () => console.log("Hello from my-extension!"));
 * };
 *
 * export default extension;
 */
export type AeryExtension = (api: ExtensionAPI) => void | Promise<void>;
