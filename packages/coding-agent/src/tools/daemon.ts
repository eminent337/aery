import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@aryee337/aery-core";
import * as z from "zod/v4";
import daemonDescription from "../prompts/tools/daemon.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { daemonStateDir, validateDaemonName } from "./daemon-state";
import { spawnDaemon } from "./daemon-spawn";

const daemonSchema = z.object({
	command: z
		.string()
		.describe(
			"Bash command line to run as the daemon (compound commands like 'a && b' are fine — the whole line runs in one shell). The returned pid is the process-group leader; a thin shell wrapper may remain if the command doesn't end in exec. Output is redirected to the daemon's log file automatically.",
		),
	name: z
		.string()
		.optional()
		.describe(
			"Short identifier for the daemon (alphanumerics/dash/underscore only, max 40 chars). Used as a prefix for its id and log files. Pick something meaningful like 'pypi-server' or 'dev-web'.",
		),
});

export type DaemonToolParams = z.infer<typeof daemonSchema>;

export type DaemonToolDetails = {
	id: string;
	pid: number;
	command: string;
	logFile: string;
	stateDir: string;
	error?: string;
};

/**
 * `daemon` tool — start a detached process that outlives the session.
 *
 * Restrictive steering: the description deliberately unattractive for
 * ordinary work. Daemons have NO timeout, NO streamed output, NO automatic
 * cleanup. They just run after the session ends.
 */
export class DaemonTool implements AgentTool<typeof daemonSchema, DaemonToolDetails> {
	readonly name = "daemon";
	readonly label = "Daemon";
	readonly description = daemonDescription;
	readonly parameters = daemonSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "start a detached service that must outlive this session (manage via daemon_control)";
	readonly approval = (): ToolApprovalDecision => ({ tier: "exec", override: true });

	constructor(private readonly session: ToolSession) {}

	async execute(
		_id: string,
		params: DaemonToolParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<DaemonToolDetails>> {
		const name = params.name === "" ? undefined : params.name;
		if (name !== undefined) {
			const nameError = validateDaemonName(name);
			if (nameError) {
				throw new ToolError(nameError);
			}
		}

		const stateDir = daemonStateDir();
		const outcome = await spawnDaemon({
			command: params.command,
			cwd: this.session.cwd,
			name,
			stateDir,
		});

		if (!outcome.ok) {
			throw new ToolError(outcome.error);
		}

		const { record } = outcome;
		return {
			content: [
				{
					type: "text",
					text:
						`Daemon started.\n  id:       ${record.id}\n  pid:      ${record.pid}\n  command:  ${record.command}\n  log file: ${record.logFile}\n\n` +
						`It is detached and will keep running after this session ends. Verify it works (e.g. curl / connect) and tell the user how to reach it. Manage with daemon_control: action "status" | "logs" | "stop", id "${record.id}".`,
				},
			],
			details: {
				id: record.id,
				pid: record.pid,
				command: record.command,
				logFile: record.logFile,
				stateDir,
			},
		};
	}
}
