import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@aryee337/aery-core";
import * as z from "zod/v4";
import daemonControlDescription from "../prompts/tools/daemon-control.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { daemonStateDir, isPidAlive, listDaemons, readDaemon } from "./daemon-state";
import { readLogTail, stopDaemon } from "./daemon-spawn";

const daemonControlSchema = z.object({
	action: z
		.union([z.literal("list"), z.literal("status"), z.literal("logs"), z.literal("stop")])
		.describe(
			"'list' shows all live daemons; 'status' checks one daemon's liveness; 'logs' tails its log file; 'stop' terminates it.",
		),
	id: z
		.string()
		.optional()
		.describe("Daemon id (returned by the daemon tool). Required for status/logs/stop."),
	max_bytes: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Only valid with action 'logs'. Max bytes to return from the end of the log file (default 8192)."),
});

export type DaemonControlParams = z.infer<typeof daemonControlSchema>;

export type DaemonControlDetails = {
	action: string;
	daemons?: Array<{ id: string; pid: number; command: string }>;
	id?: string;
	alive?: boolean;
	pid?: number;
	logFile?: string;
	error?: string;
};

function formatUptime(startedAt: string): string {
	const ms = Date.now() - new Date(startedAt).getTime();
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

/**
 * `daemon_control` tool — inspect and stop detached daemons.
 *
 * Companion to the `daemon` tool. Daemons are NOT managed by bash_control
 * — those handles belong to the bash tool's session-scoped background mode.
 */
export class DaemonControlTool implements AgentTool<typeof daemonControlSchema, DaemonControlDetails> {
	readonly name = "daemon_control";
	readonly label = "Daemon Control";
	readonly description = daemonControlDescription;
	readonly parameters = daemonControlSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "check or stop detached daemons";
	readonly approval = (): ToolApprovalDecision => ({ tier: "exec", override: true });

	constructor(private readonly session: ToolSession) {}

	async execute(
		_id: string,
		params: DaemonControlParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<DaemonControlDetails>> {
		const { action, id } = params;
		const stateDir = daemonStateDir();

		if (action === "list") {
			const live = listDaemons(stateDir);
			if (live.length === 0) {
				return {
					content: [{ type: "text", text: "No live daemons." }],
					details: { action, daemons: [] },
				};
			}
			const lines = live.map(
				({ record }) =>
					`${record.id}  pid ${record.pid}  up ${formatUptime(record.startedAt)}\n  ${record.command}\n  log: ${record.logFile}`,
			);
			return {
				content: [{ type: "text", text: `${live.length} live daemon(s):\n\n${lines.join("\n\n")}` }],
				details: {
					action,
					daemons: live.map(({ record }) => ({ id: record.id, pid: record.pid, command: record.command })),
				},
			};
		}

		if (!id) {
			throw new ToolError(`action "${action}" requires an 'id' (from the daemon tool or daemon_control list).`);
		}
		const record = readDaemon(stateDir, id);
		if (!record) {
			throw new ToolError(
				`Daemon '${id}' is not recorded (already stopped, or never started here). Run daemon_control action "list" to see live daemons.`,
			);
		}

		if (action === "status") {
			const live = isPidAlive(record.pid);
			return {
				content: [
					{
						type: "text",
						text:
							`Daemon ${record.id}: ${live ? "RUNNING" : "not running"}\n` +
							`  pid:      ${record.pid}\n  command:  ${record.command}\n  cwd:      ${record.cwd}\n` +
							`  started:  ${record.startedAt} (up ${formatUptime(record.startedAt)})\n  log:      ${record.logFile}`,
					},
				],
				details: { action, id, alive: live, pid: record.pid },
			};
		}

		if (action === "logs") {
			const tail = readLogTail(record.logFile, params.max_bytes ?? 8192);
			return {
				content: [
					{
						type: "text",
						text: tail !== undefined ? tail : `(no log output yet — ${record.logFile} is missing or empty)`,
					},
				],
				details: { action, id, logFile: record.logFile },
			};
		}

		if (action === "stop") {
			const { note } = await stopDaemon(record, stateDir);
			return {
				content: [{ type: "text", text: note }],
				details: { action, id, pid: record.pid },
			};
		}

		throw new ToolError(`Unknown daemon_control action "${action}". Valid actions: list, status, logs, stop.`);
	}
}
