/**
 * Terminal Pane Spawner & Orchestrator Tool.
 *
 * Allows Aerys (and subagents) to programmatically spawn, split, send input to,
 * read from, and manage visible terminal panes/windows.
 *
 * Backends:
 * 1. Tmux: splits panes in the active session ($TMUX) or launches a managed session.
 * 2. Kitty: uses Kitty remote control socket (`kitty @ launch`, `kitty @ send-text`, etc.).
 * 3. Window Fallback: launches an independent GUI terminal (e.g. Kitty window) under X11/Wayland.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { getProjectDir } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import type { ToolSession } from "./index";

const execFileAsync = promisify(execFile);

export interface PaneInfo {
	paneId: string;
	backend: "tmux" | "kitty" | "window";
	title?: string;
	command?: string;
	cwd: string;
	status: "running" | "closed";
}

const terminalPaneSchema = z.object({
	action: z
		.enum(["split", "run", "read", "close", "list"])
		.describe(
			"Action to perform: 'split' opens a new visible pane, 'run' sends keys/command to an existing pane, 'read' gets recent buffer output, 'close' kills a pane, 'list' shows active panes.",
		),
	direction: z
		.enum(["horizontal", "vertical"])
		.optional()
		.describe(
			"Split direction for action 'split'. 'horizontal' splits side-by-side (left/right), 'vertical' splits top/bottom. Default: 'horizontal'.",
		),
	command: z
		.string()
		.optional()
		.describe("Command or script to execute in the pane (e.g. 'aery', 'npm test', 'htop')."),
	cwd: z
		.string()
		.optional()
		.describe("Working directory for the pane. Defaults to the current project directory."),
	paneId: z
		.string()
		.optional()
		.describe("Target pane ID (e.g. '%1', 'kitty-window-3') required for 'run', 'read', and 'close'."),
	lines: z
		.number()
		.int()
		.optional()
		.describe("Number of output lines to capture when using action 'read'. Default: 50."),
	title: z.string().optional().describe("Optional window or pane title label."),
});

export type TerminalPaneParams = z.infer<typeof terminalPaneSchema>;

// Global in-memory registry of panes spawned by Aerys
const managedPanes = new Map<string, PaneInfo>();

async function runCmd(
	cmd: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			timeout: 10_000,
		});
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; code?: number; message: string };
		return {
			stdout: error.stdout?.trim() || "",
			stderr: error.stderr?.trim() || error.message,
			code: error.code ?? 1,
		};
	}
}

/** Check if Tmux is active in the current environment */
function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX);
}

/** Check if Kitty remote control socket is reachable */
async function getKittySocket(): Promise<string | undefined> {
	if (process.env.KITTY_LISTEN_ON) {
		return process.env.KITTY_LISTEN_ON;
	}
	const candidates = ["/tmp/kitty.sock", `/tmp/kitty-${process.env.KITTY_PID}.sock`];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return `unix:${candidate}`;
	}
	return undefined;
}

/** Tmux backend implementation */
const tmuxBackend = {
	async split(direction: "horizontal" | "vertical", cmd?: string, cwd?: string, title?: string): Promise<PaneInfo> {
		const splitFlag = direction === "horizontal" ? "-h" : "-v";
		const targetCwd = cwd || getProjectDir();
		const args = ["split-window", splitFlag, "-P", "-F", "#{pane_id}", "-c", targetCwd];

		if (cmd) {
			args.push(cmd);
		}

		const res = await runCmd("tmux", args);
		if (res.code !== 0) {
			throw new Error(`tmux split-window failed: ${res.stderr}`);
		}

		const paneId = res.stdout;
		if (title) {
			await runCmd("tmux", ["select-pane", "-t", paneId, "-T", title]);
		}

		const info: PaneInfo = {
			paneId,
			backend: "tmux",
			title,
			command: cmd,
			cwd: targetCwd,
			status: "running",
		};
		managedPanes.set(paneId, info);
		return info;
	},

	async run(paneId: string, command: string): Promise<void> {
		const res = await runCmd("tmux", ["send-keys", "-t", paneId, command, "Enter"]);
		if (res.code !== 0) {
			throw new Error(`tmux send-keys failed on pane ${paneId}: ${res.stderr}`);
		}
	},

	async read(paneId: string, lines = 50): Promise<string> {
		const res = await runCmd("tmux", ["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
		if (res.code !== 0) {
			throw new Error(`tmux capture-pane failed on pane ${paneId}: ${res.stderr}`);
		}
		return res.stdout;
	},

	async close(paneId: string): Promise<void> {
		const res = await runCmd("tmux", ["kill-pane", "-t", paneId]);
		if (res.code !== 0) {
			throw new Error(`tmux kill-pane failed on pane ${paneId}: ${res.stderr}`);
		}
		const existing = managedPanes.get(paneId);
		if (existing) existing.status = "closed";
	},

	async list(): Promise<PaneInfo[]> {
		const res = await runCmd("tmux", [
			"list-panes",
			"-F",
			"#{pane_id}|#{pane_current_command}|#{pane_current_path}|#{pane_title}",
		]);
		if (res.code !== 0) return Array.from(managedPanes.values());

		const active = new Map<string, PaneInfo>();
		for (const line of res.stdout.split("\n")) {
			if (!line.trim()) continue;
			const [id, currentCmd, currentPath, title] = line.split("|");
			if (!id) continue;
			active.set(id, {
				paneId: id,
				backend: "tmux",
				title: title || undefined,
				command: currentCmd || undefined,
				cwd: currentPath || getProjectDir(),
				status: "running",
			});
		}
		return Array.from(active.values());
	},
};

/** Kitty remote control backend implementation */
const kittyBackend = {
	async split(
		socket: string | undefined,
		direction: "horizontal" | "vertical",
		cmd?: string,
		cwd?: string,
		title?: string,
	): Promise<PaneInfo> {
		const location = direction === "horizontal" ? "vsplit" : "hsplit";
		const targetCwd = cwd || getProjectDir();
		const args = ["@"];
		if (socket) args.push("--to", socket);
		args.push("launch", `--location=${location}`, `--cwd=${targetCwd}`);

		if (title) args.push(`--window-title=${title}`);
		if (cmd) {
			// Pass command to run inside the split
			args.push(...cmd.split(" "));
		}

		const res = await runCmd("kitty", args);
		if (res.code !== 0) {
			throw new Error(`kitty @ launch failed: ${res.stderr}`);
		}

		// Kitty returns the window id on stdout if successful
		const paneId = `kitty-${res.stdout.trim() || Date.now()}`;
		const info: PaneInfo = {
			paneId,
			backend: "kitty",
			title,
			command: cmd,
			cwd: targetCwd,
			status: "running",
		};
		managedPanes.set(paneId, info);
		return info;
	},

	async run(socket: string | undefined, paneId: string, command: string): Promise<void> {
		const rawId = paneId.replace(/^kitty-/, "");
		const args = ["@"];
		if (socket) args.push("--to", socket);
		args.push("send-text", `--match=id:${rawId}`, `${command}\n`);

		const res = await runCmd("kitty", args);
		if (res.code !== 0) {
			throw new Error(`kitty @ send-text failed on ${paneId}: ${res.stderr}`);
		}
	},

	async read(socket: string | undefined, paneId: string): Promise<string> {
		const rawId = paneId.replace(/^kitty-/, "");
		const args = ["@"];
		if (socket) args.push("--to", socket);
		args.push("get-text", `--match=id:${rawId}`);

		const res = await runCmd("kitty", args);
		if (res.code !== 0) {
			throw new Error(`kitty @ get-text failed on ${paneId}: ${res.stderr}`);
		}
		return res.stdout;
	},

	async close(socket: string | undefined, paneId: string): Promise<void> {
		const rawId = paneId.replace(/^kitty-/, "");
		const args = ["@"];
		if (socket) args.push("--to", socket);
		args.push("close-window", `--match=id:${rawId}`);

		const res = await runCmd("kitty", args);
		if (res.code !== 0) {
			throw new Error(`kitty @ close-window failed on ${paneId}: ${res.stderr}`);
		}
		const existing = managedPanes.get(paneId);
		if (existing) existing.status = "closed";
	},
};

/** Standalone terminal window spawn (X11/Wayland fallback) */
const windowFallbackBackend = {
	async spawn(cmd?: string, cwd?: string, title?: string): Promise<PaneInfo> {
		const targetCwd = cwd || getProjectDir();
		const paneId = `win-${Date.now()}`;
		const terminalApp = process.env.KITTY_PID ? "kitty" : "x-terminal-emulator";

		const args = ["--directory", targetCwd];
		if (title) args.push("--title", title);
		if (cmd) args.push(...cmd.split(" "));

		// Spawn detached window
		const res = await runCmd(terminalApp, args);
		if (res.code !== 0) {
			throw new Error(`Failed to launch terminal window: ${res.stderr}`);
		}

		const info: PaneInfo = {
			paneId,
			backend: "window",
			title,
			command: cmd,
			cwd: targetCwd,
			status: "running",
		};
		managedPanes.set(paneId, info);
		return info;
	},
};

export class TerminalPaneTool implements AgentTool<typeof terminalPaneSchema> {
	readonly name = "terminal_pane";
	readonly approval = "exec" as const;
	readonly label = "Terminal Pane";
	readonly description =
		"Programmatically spawn, split, run commands in, read from, or close visible terminal panes and windows (supporting Kitty remote control, Tmux, and standalone terminal windows). Use this to orchestrate visual subagents and parallel terminal workflows.";
	readonly parameters = terminalPaneSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage visible terminal panes (split, run, read, close, list)";

	static createIf(_session: ToolSession): TerminalPaneTool | null {
		return new TerminalPaneTool();
	}

	async execute(_id: string, params: TerminalPaneParams): Promise<AgentToolResult> {
		const kittySocket = await getKittySocket();
		const inTmux = isInsideTmux();

		switch (params.action) {
			case "split": {
				const direction = params.direction ?? "horizontal";
				const targetCwd = params.cwd ? path.resolve(getProjectDir(), params.cwd) : getProjectDir();

				let pane: PaneInfo;
				if (inTmux) {
					pane = await tmuxBackend.split(direction, params.command, targetCwd, params.title);
				} else if (kittySocket || process.env.KITTY_PID) {
					try {
						pane = await kittyBackend.split(kittySocket, direction, params.command, targetCwd, params.title);
					} catch (err) {
						// If remote control socket failed, fallback to standalone window
						pane = await windowFallbackBackend.spawn(params.command, targetCwd, params.title);
					}
				} else {
					pane = await windowFallbackBackend.spawn(params.command, targetCwd, params.title);
				}

				return {
					content: [
						{
							type: "text",
							text: `Spawned ${pane.backend} pane [${pane.paneId}] (${direction}) in "${pane.cwd}"${params.command ? ` running: ${params.command}` : ""}.`,
						},
					],
					details: pane,
				};
			}

			case "run": {
				if (!params.paneId) {
					return {
						content: [{ type: "text", text: "Error: paneId is required for action 'run'." }],
						details: { error: "missing_pane_id" },
					};
				}
				if (!params.command) {
					return {
						content: [{ type: "text", text: "Error: command is required for action 'run'." }],
						details: { error: "missing_command" },
					};
				}

				const pane = managedPanes.get(params.paneId);
				if (inTmux || pane?.backend === "tmux") {
					await tmuxBackend.run(params.paneId, params.command);
				} else if (kittySocket || pane?.backend === "kitty") {
					await kittyBackend.run(kittySocket, params.paneId, params.command);
				} else {
					throw new Error(`Cannot send keys to pane ${params.paneId}: backend not supported for remote keys.`);
				}

				return {
					content: [{ type: "text", text: `Sent command to pane [${params.paneId}]: ${params.command}` }],
					details: { paneId: params.paneId, command: params.command, success: true },
				};
			}

			case "read": {
				if (!params.paneId) {
					return {
						content: [{ type: "text", text: "Error: paneId is required for action 'read'." }],
						details: { error: "missing_pane_id" },
					};
				}

				const lines = params.lines ?? 50;
				const pane = managedPanes.get(params.paneId);
				let output: string;

				if (inTmux || pane?.backend === "tmux") {
					output = await tmuxBackend.read(params.paneId, lines);
				} else if (kittySocket || pane?.backend === "kitty") {
					output = await kittyBackend.read(kittySocket, params.paneId);
				} else {
					throw new Error(`Cannot read output from pane ${params.paneId}.`);
				}

				return {
					content: [{ type: "text", text: output || "(pane buffer is empty)" }],
					details: { paneId: params.paneId, linesRead: lines },
				};
			}

			case "close": {
				if (!params.paneId) {
					return {
						content: [{ type: "text", text: "Error: paneId is required for action 'close'." }],
						details: { error: "missing_pane_id" },
					};
				}

				const pane = managedPanes.get(params.paneId);
				if (inTmux || pane?.backend === "tmux") {
					await tmuxBackend.close(params.paneId);
				} else if (kittySocket || pane?.backend === "kitty") {
					await kittyBackend.close(kittySocket, params.paneId);
				}
				managedPanes.delete(params.paneId);

				return {
					content: [{ type: "text", text: `Closed pane [${params.paneId}].` }],
					details: { paneId: params.paneId, closed: true },
				};
			}

			case "list": {
				let list: PaneInfo[];
				if (inTmux) {
					list = await tmuxBackend.list();
				} else {
					list = Array.from(managedPanes.values()).filter(p => p.status === "running");
				}

				if (list.length === 0) {
					return {
						content: [{ type: "text", text: "No active terminal panes found." }],
						details: { panes: [] },
					};
				}

				const formatted = list
					.map(p => `- [${p.paneId}] (${p.backend}): ${p.title || p.command || "shell"} in ${p.cwd}`)
					.join("\n");

				return {
					content: [{ type: "text", text: `Active Panes:\n${formatted}` }],
					details: { panes: list },
				};
			}
		}
	}
}
