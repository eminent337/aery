/**
 * Sidecar Management CLI (`aery sidecar`).
 *
 * Supervised persistent background processes matching Google Antigravity.
 */

import { Command } from "@aryee337/aery-utils/cli";
import { SidecarManager } from "../sidecars/sidecar-manager";

export async function handleSidecarCli(argv: string[]): Promise<void> {
	const manager = SidecarManager.getInstance();
	await manager.discover(process.cwd());

	const sub = argv[0];

	if (!sub || sub === "list") {
		const list = manager.list();
		if (list.length === 0) {
			console.log("No sidecars registered or discovered in ~/.aery/sidecars or .agents/sidecars.");
			return;
		}

		console.log("Registered Sidecars:");
		console.log("----------------------------------------------------------------------");
		console.log(`${"ID".padEnd(16)} ${"STATUS".padEnd(12)} ${"PID".padEnd(8)} ${"RESTARTS".padEnd(10)} COMMAND`);
		console.log("----------------------------------------------------------------------");
		for (const s of list) {
			const pidStr = s.pid ? String(s.pid) : "-";
			const cmd = `${s.config.command} ${(s.config.args || []).join(" ")}`;
			console.log(
				`${s.id.padEnd(16)} ${s.status.padEnd(12)} ${pidStr.padEnd(8)} ${String(s.restartCount).padEnd(10)} ${cmd}`,
			);
		}
		return;
	}

	const targetId = argv[1];

	if (sub === "start") {
		if (!targetId) {
			console.error("Usage: aery sidecar start <id>");
			process.exit(1);
		}
		try {
			const info = await manager.start(targetId);
			console.log(`Started sidecar '${targetId}' (status: ${info.status}, pid: ${info.pid ?? "-"})`);
		} catch (err: unknown) {
			console.error(`Failed to start sidecar '${targetId}':`, err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
		return;
	}

	if (sub === "stop") {
		if (!targetId) {
			console.error("Usage: aery sidecar stop <id>");
			process.exit(1);
		}
		await manager.stop(targetId);
		console.log(`Stopped sidecar '${targetId}'.`);
		return;
	}

	if (sub === "restart") {
		if (!targetId) {
			console.error("Usage: aery sidecar restart <id>");
			process.exit(1);
		}
		const info = await manager.restart(targetId);
		console.log(`Restarted sidecar '${targetId}' (status: ${info.status}, pid: ${info.pid ?? "-"})`);
		return;
	}

	if (sub === "logs") {
		if (!targetId) {
			console.error("Usage: aery sidecar logs <id> [lines]");
			process.exit(1);
		}
		const lines = argv[2] ? parseInt(argv[2], 10) : 50;
		const logs = await manager.getLogs(targetId, lines);
		console.log(logs || `[No logs found for sidecar '${targetId}']`);
		return;
	}

	if (sub === "status") {
		if (!targetId) {
			console.error("Usage: aery sidecar status <id>");
			process.exit(1);
		}
		const status = manager.getStatus(targetId);
		if (!status) {
			console.error(`Sidecar '${targetId}' not found.`);
			process.exit(1);
		}
		console.log(JSON.stringify(status, null, 2));
		return;
	}

	console.log("Usage: aery sidecar [list | start <id> | stop <id> | restart <id> | logs <id> | status <id>]");
}

export default class Sidecar extends Command {
	static description = "Manage persistent background sidecar companion processes";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(Sidecar);
		await handleSidecarCli(argv as string[]);
	}
}
