/**
 * Terminal multiplexer detection and pane integration.
 *
 * When Aery is running inside Zellij, tmux, or WezTerm, the external editor
 * can open in a new pane instead of taking over the current terminal.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";

export type MultiplexerType = "zellij" | "tmux" | "wezterm";

export interface MultiplexerInfo {
	type: MultiplexerType;
	executable: string;
}

/** Detect whether we're running inside a supported terminal multiplexer. */
export function detectMultiplexer(): MultiplexerInfo | null {
	if (process.env.ZELLIJ) {
		const exe = whichSync("zellij");
		if (exe) return { type: "zellij", executable: exe };
	}
	if (process.env.TMUX) {
		const exe = whichSync("tmux");
		if (exe) return { type: "tmux", executable: exe };
	}
	if (process.env.WEZTERM_PANE) {
		const exe = whichSync("wezterm");
		if (exe) return { type: "wezterm", executable: exe };
	}
	return null;
}

/** Synchronously resolve a command on PATH. Returns the absolute path or undefined. */
function whichSync(command: string): string | undefined {
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const out = execFileSync(cmd, [command], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
		const first = out.trim().split("\n")[0];
		return first || undefined;
	} catch {
		return undefined;
	}
}

export interface OpenMultiplexerPaneOptions {
	/** Path to the file to edit. */
	filePath: string;
	/** Editor command (e.g. "vim", "nano"). */
	editorCmd: string;
	/** Optional AbortSignal to cancel waiting. */
	signal?: AbortSignal;
	/** Maximum time to wait for the editor to finish (ms). Default 1_800_000 (30 min). */
	timeoutMs?: number;
	/** How often to poll the sentinel file (ms). Default 500. */
	pollIntervalMs?: number;
}

/** Result of opening a multiplexer pane. */
export interface MultiplexerPaneResult {
	/** The editor process exit code. */
	exitCode: number;
}

/**
 * Open the editor in a new multiplexer pane and block until the pane closes.
 *
 * Uses a sentinel file written by a shell wrapper so we can wait even though
 * the multiplexer CLIs (zellij run, tmux split-window, wezterm cli split-pane)
 * all return immediately.
 */
export async function openMultiplexerPane(
	mux: MultiplexerInfo,
	options: OpenMultiplexerPaneOptions,
): Promise<MultiplexerPaneResult> {
	const { filePath, editorCmd, signal, timeoutMs = 1_800_000, pollIntervalMs = 500 } = options;

	const sentinelPath = `${filePath}.done`;
	// Clean up stale sentinel from a previous run
	try {
		await fs.rm(sentinelPath, { force: true });
	} catch {
		// ignore
	}

	const [editor, ...editorArgs] = editorCmd.split(" ");
	const editorPart = `${quoteShellArg(editor)} ${editorArgs.map(quoteShellArg).join(" ")} ${quoteShellArg(filePath)}`;
	// Write exit code to sentinel so the caller knows whether the editor succeeded
	const wrapperCmd = `${editorPart}; echo $? > ${quoteShellArg(sentinelPath)}`;

	switch (mux.type) {
		case "zellij": {
			// zellij run opens a new pane and runs the command.
			// --close-on-exit removes the pane when the editor exits.
			spawn(mux.executable, ["run", "--close-on-exit", "--", "sh", "-c", wrapperCmd], {
				detached: true,
				stdio: "ignore",
			});
			break;
		}
		case "tmux": {
			// -v = vertical split (pane below)
			// -d = do not switch to the new pane
			// -c <cwd> = start in current directory
			// The pane auto-closes when the shell exits.
			spawn(
				mux.executable,
				["split-window", "-v", "-d", "-c", process.cwd(), "sh", "-c", wrapperCmd],
				{ detached: true, stdio: "ignore" },
			);
			break;
		}
		case "wezterm": {
			// split-pane creates a new pane running the command.
			// The pane closes when the shell exits.
			spawn(mux.executable, ["cli", "split-pane", "--", "sh", "-c", wrapperCmd], {
				detached: true,
				stdio: "ignore",
			});
			break;
		}
	}

	// Wait for sentinel to appear
	await waitForSentinel(sentinelPath, signal, timeoutMs, pollIntervalMs);

	// Read exit code from sentinel
	const exitCodeStr = await fs.readFile(sentinelPath, "utf-8");
	const exitCode = Number(exitCodeStr.trim()) || 0;

	// Clean up sentinel
	try {
		await fs.rm(sentinelPath, { force: true });
	} catch {
		// ignore
	}

	return { exitCode };
}

async function waitForSentinel(
	sentinelPath: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	pollIntervalMs: number,
): Promise<void> {
	const start = Date.now();

	return new Promise((resolve, reject) => {
		let interval: ReturnType<typeof setInterval> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (interval) clearInterval(interval);
			if (timeout) clearTimeout(timeout);
		};

		if (signal) {
			const onAbort = (): void => {
				cleanup();
				reject(new Error("Editor pane was aborted."));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const check = async (): Promise<void> => {
			try {
				await fs.access(sentinelPath);
				cleanup();
				resolve();
				return;
			} catch {
				// not yet
			}

			if (Date.now() - start > timeoutMs) {
				cleanup();
				reject(new Error(`Editor pane timed out after ${timeoutMs}ms.`));
			}
		};

		interval = setInterval(check, pollIntervalMs);
		timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Editor pane timed out after ${timeoutMs}ms.`));
		}, timeoutMs + pollIntervalMs * 2);

		void check();
	});
}

/** Minimal POSIX shell quoting. */
function quoteShellArg(arg: string): string {
	if (/^[a-zA-Z0-9_./:@+-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}
