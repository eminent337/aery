// ─── Command Building Helpers ─────────────────────────────────────────────────

import type { AeryCommandHandler, ExtensionAPI } from "./extension";

/**
 * Register a slash-command on the given API instance.
 * A thin wrapper around `api.registerCommand()` for ergonomic use in
 * modular extension setups where the API is passed around.
 *
 * @example
 * defineCommand(api, "deploy", {
 *   description: "Deploy the current project",
 *   handler: async (args) => { ... },
 * });
 */
export function defineCommand(api: ExtensionAPI, name: string, handler: AeryCommandHandler): void {
	api.registerCommand(name, handler);
}

/**
 * Parse a raw slash-command argument string into structured parts.
 *
 * Supports:
 * - A leading **subcommand** word
 * - `--flag` boolean flags
 * - `--flag=value` key-value flags
 * - Remaining positional tokens collected as `rest`
 *
 * @example
 * // User ran: /marketplace install my-plugin --version=2.0 --force
 * const { subcommand, rest, flags } = parseArgs("install my-plugin --version=2.0 --force");
 * // subcommand → "install"
 * // rest       → "my-plugin"
 * // flags      → { version: "2.0", force: true }
 */
export function parseArgs(raw: string): {
	subcommand: string;
	rest: string;
	flags: Record<string, string | boolean>;
} {
	const parts = raw.trim().split(/\s+/);
	const subcommand = parts[0] ?? "";
	const flags: Record<string, string | boolean> = {};
	const remaining: string[] = [];

	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (part.startsWith("--")) {
			const eqIdx = part.indexOf("=");
			if (eqIdx !== -1) {
				const key = part.slice(2, eqIdx);
				const val = part.slice(eqIdx + 1);
				flags[key] = val;
			} else {
				flags[part.slice(2)] = true;
			}
		} else {
			remaining.push(part);
		}
	}

	return { subcommand, rest: remaining.join(" "), flags };
}
