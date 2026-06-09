/**
 * RTK (Rust Token Killer) Integration for Aery.
 *
 * When the `rtk` binary is available, bash commands are rewritten through
 * `rtk rewrite <cmd>` before execution. This compresses command output by
 * 60-90% for common dev tools (git, cargo, npm, etc.).
 *
 * Architecture:
 * - Probes for `rtk` binary once at session start
 * - Hooks into `tool_call` to rewrite bash commands before execution
 * - Caches rewrite results for display in the TUI
 *
 * Reference: https://github.com/rtk-ai/rtk
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "../extensibility/extensions/types.js";

// ──────────────────────────────────────────────────────────────────────────
// RTK Detection
// ──────────────────────────────────────────────────────────────────────────

/** Tri-state: undefined = not yet probed, true/false = cached result. */
let rtkAvailable: boolean | undefined;

/** Cached in-flight detection promise to avoid concurrent spawns. */
let rtkDetectPromise: Promise<boolean> | undefined;

function rtkBinary(): string {
	// Check common installation paths
	const globalPath = `${process.env.HOME}/.local/bin/rtk`;
	if (existsSync(globalPath)) return globalPath;

	const cargoPath = `${process.env.HOME}/.cargo/bin/rtk`;
	if (existsSync(cargoPath)) return cargoPath;

	return "rtk";
}

/**
 * Probe for the `rtk` binary once per process.
 * Returns true when rtk is installed and responds to `--version` within 1s.
 */
export function detectRtk(): Promise<boolean> {
	if (rtkAvailable !== undefined) return Promise.resolve(rtkAvailable);
	if (rtkDetectPromise) return rtkDetectPromise;

	rtkDetectPromise = new Promise<boolean>(resolve => {
		execFile(rtkBinary(), ["--version"], { timeout: 1000 }, err => {
			rtkAvailable = !err;
			rtkDetectPromise = undefined;
			resolve(rtkAvailable);
		});
	});
	return rtkDetectPromise;
}

// ──────────────────────────────────────────────────────────────────────────
// Command Passthrough Rules
// ──────────────────────────────────────────────────────────────────────────

/**
 * Package-manager script invocations that RTK must not rewrite.
 * RTK maps `pnpm run lint` → `rtk lint` (its own lint subcommand),
 * which mangles the command. These must reach the package manager unchanged.
 */
const RTK_PASSTHROUGH_RE = /^\s*(pnpm|npm|yarn|bun)\s+run\b|^\s*(npx|bunx)\s|^\s*pnpm\s+exec\s/;

/** Returns true for commands that must bypass RTK rewriting. */
export function isRtkPassthrough(command: string): boolean {
	return RTK_PASSTHROUGH_RE.test(command);
}

// ──────────────────────────────────────────────────────────────────────────
// Command Rewriting
// ──────────────────────────────────────────────────────────────────────────

/**
 * Synchronously rewrite a command through `rtk rewrite`.
 * Returns the original command unchanged when:
 * - rtk is not available
 * - the command is a package-manager script invocation
 * - rtk returns empty output or the same string
 * - the subprocess times out or fails
 */
export function rewriteWithRtk(command: string): string {
	if (rtkAvailable === false && rtkBinary() === "rtk") return command;
	if (isRtkPassthrough(command)) return command;

	try {
		const stdout = execFileSync(rtkBinary(), ["rewrite", command], {
			timeout: 2000,
			encoding: "utf-8",
		});
		const rewritten = stdout.trim();
		return rewritten && rewritten !== command ? rewritten : command;
	} catch (err) {
		// RTK uses exit code 3 to signal a successful rewrite
		const execErr = err as { status?: number; stdout?: string; code?: string };
		if (execErr.status === 3 && typeof execErr.stdout === "string") {
			const rewritten = execErr.stdout.trim();
			return rewritten && rewritten !== command ? rewritten : command;
		}
		// On first ENOENT, cache the negative result
		if (execErr.code === "ENOENT") {
			rtkAvailable = false;
		}
		return command;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Display Cache
// ──────────────────────────────────────────────────────────────────────────

/** Cache of rewrite results so TUI renderers can display without subprocess. */
const rewriteCache = new Map<string, string>();

/**
 * Get the rewritten command for display.
 * Returns the rewritten version if cached, otherwise the original.
 */
export function getBashCommandForDisplay(command: string | undefined): string | undefined {
	if (!command) return command;
	return rewriteCache.get(command) ?? command;
}

// ──────────────────────────────────────────────────────────────────────────
// Extension Factory
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create the RTK extension.
 * Registers a `tool_call` handler that rewrites bash commands through RTK.
 */
export function createRtkExtension() {
	return function rtkExtension(api: ExtensionAPI): void {
		// Eagerly probe for rtk at extension load time (non-blocking)
		detectRtk();

		api.on("tool_call", event => {
			if (event.toolName !== "bash") return;
			const input = event.input as Record<string, unknown>;
			const command = input.command;
			if (typeof command !== "string") return;

			const rewritten = rewriteWithRtk(command);
			if (rewritten !== command) {
				rewriteCache.set(command, rewritten);
				input.command = rewritten;
			}
		});
	};
}
