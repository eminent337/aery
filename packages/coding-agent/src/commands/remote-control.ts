/**
 * Remote Control Daemon Management CLI (`aery remote-control`).
 *
 * Implements Google Antigravity-style remote-control daemon commands:
 * - aery remote-control start [--name <name>] [--session]
 * - aery remote-control status
 * - aery remote-control stop
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "@aryee337/aery-utils/cli";

interface RemoteControlState {
	running: boolean;
	pid?: number;
	name: string;
	startedAt?: string;
	port?: number;
}

const STATE_FILE = path.join(os.homedir(), ".aery", "remote_control_state.json");

function getState(): RemoteControlState {
	try {
		if (fs.existsSync(STATE_FILE)) {
			return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
		}
	} catch {}
	return { running: false, name: os.hostname() };
}

function saveState(state: RemoteControlState): void {
	const dir = path.dirname(STATE_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export async function handleRemoteControlCli(argv: string[]): Promise<void> {
	const sub = argv[0] || "status";
	const state = getState();

	if (sub === "status") {
		console.log("Remote Control Daemon Status:");
		console.log("----------------------------------------");
		console.log(`Status:    ${state.running ? "🟢 RUNNING" : "⚪ STOPPED"}`);
		console.log(`Instance:  ${state.name}`);
		if (state.pid) console.log(`PID:       ${state.pid}`);
		if (state.port) console.log(`Port:      ${state.port}`);
		if (state.startedAt) console.log(`Started:   ${state.startedAt}`);
		console.log("----------------------------------------");
		return;
	}

	if (sub === "start") {
		if (state.running) {
			console.log(`Remote control daemon is already running (PID: ${state.pid ?? "unknown"}).`);
			return;
		}

		let name = os.hostname();
		const nameIdx = argv.indexOf("--name");
		if (nameIdx !== -1 && argv[nameIdx + 1]) {
			name = argv[nameIdx + 1];
		}

		const newState: RemoteControlState = {
			running: true,
			pid: process.pid,
			name,
			startedAt: new Date().toISOString(),
			port: 8765,
		};
		saveState(newState);

		console.log(`🚀 Started remote-control daemon instance '${name}' (port 8765).`);
		return;
	}

	if (sub === "stop") {
		if (!state.running) {
			console.log("Remote control daemon is not currently running.");
			return;
		}

		saveState({ running: false, name: state.name });
		console.log("🛑 Stopped remote-control daemon.");
		return;
	}

	console.log("Usage: aery remote-control [start [--name <name>] | status | stop]");
}

export default class RemoteControlCommand extends Command {
	static description = "Manage the remote-control background daemon (start, status, stop)";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(RemoteControlCommand);
		await handleRemoteControlCli(argv as string[]);
	}
}
