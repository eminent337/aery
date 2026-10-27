/**
 * Sidecar Process Manager & Supervisor.
 *
 * Implements Google Antigravity-style persistent background sidecar supervision.
 * Handles process lifecycle, restart policies, isolated stdout/stderr logging,
 * and workspace/global discovery.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SidecarConfig, SidecarProcessInfo, SidecarStatus } from "./types";

interface ActiveSidecar {
	config: SidecarConfig;
	process?: ChildProcess;
	status: SidecarStatus;
	pid?: number;
	startedAt?: number;
	restartCount: number;
	lastError?: string;
	logPath: string;
	restartTimeouts?: ReturnType<typeof setTimeout>;
}

export class SidecarManager {
	private static instance?: SidecarManager;
	private sidecars = new Map<string, ActiveSidecar>();
	private baseDataDir: string;

	constructor(baseDataDir?: string) {
		this.baseDataDir = baseDataDir ?? path.join(os.homedir(), ".aery", "sidecar_data");
	}

	public static getInstance(): SidecarManager {
		if (!SidecarManager.instance) {
			SidecarManager.instance = new SidecarManager();
		}
		return SidecarManager.instance;
	}

	/**
	 * Discovers sidecars defined in standard global and workspace paths:
	 * 1. ~/.aery/sidecars/<id>/sidecar.json
	 * 2. <workspace>/.agents/sidecars/<id>/sidecar.json
	 * 3. <workspace>/.aery/sidecars/<id>/sidecar.json
	 */
	public async discover(workspaceDir?: string): Promise<SidecarConfig[]> {
		const searchDirs: string[] = [path.join(os.homedir(), ".aery", "sidecars")];

		if (workspaceDir) {
			searchDirs.push(path.join(workspaceDir, ".agents", "sidecars"));
			searchDirs.push(path.join(workspaceDir, ".aery", "sidecars"));
		}

		const discovered: SidecarConfig[] = [];

		for (const dir of searchDirs) {
			if (!fs.existsSync(dir)) continue;
			try {
				const entries = await fs.promises.readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const configPath = path.join(dir, entry.name, "sidecar.json");
						if (fs.existsSync(configPath)) {
							try {
								const raw = await fs.promises.readFile(configPath, "utf-8");
								const parsed = JSON.parse(raw);
								const id = parsed.id || entry.name;
								const config: SidecarConfig = {
									id,
									name: parsed.name || parsed.displayName || id,
									description: parsed.description,
									command: parsed.command,
									args: parsed.args || [],
									env: parsed.env,
									cwd: parsed.cwd || path.join(dir, entry.name),
									restartPolicy: parsed.restart_policy || parsed.restartPolicy || "on-failure",
									maxRestarts: parsed.max_restarts || parsed.maxRestarts || 5,
								};
								this.register(config);
								discovered.push(config);
							} catch (err) {
								console.error(`Failed to parse sidecar config at ${configPath}:`, err);
							}
						}
					}
				}
			} catch {}
		}

		return discovered;
	}

	/**
	 * Registers a sidecar configuration in the manager.
	 */
	public register(config: SidecarConfig): void {
		const logDir = path.join(this.baseDataDir, config.id);
		try {
			fs.mkdirSync(logDir, { recursive: true });
		} catch {}

		const logPath = path.join(logDir, "sidecar.log");

		if (!this.sidecars.has(config.id)) {
			this.sidecars.set(config.id, {
				config,
				status: "stopped",
				restartCount: 0,
				logPath,
			});
		} else {
			const existing = this.sidecars.get(config.id)!;
			existing.config = config;
			existing.logPath = logPath;
		}
	}

	/**
	 * Starts a registered sidecar process.
	 */
	public async start(id: string): Promise<SidecarProcessInfo> {
		const sidecar = this.sidecars.get(id);
		if (!sidecar) {
			throw new Error(`Sidecar '${id}' is not registered`);
		}

		if (sidecar.status === "running" && sidecar.process && !sidecar.process.killed) {
			return this.toProcessInfo(sidecar);
		}

		return this.spawnProcess(sidecar);
	}

	/**
	 * Stops a running sidecar process.
	 */
	public async stop(id: string): Promise<void> {
		const sidecar = this.sidecars.get(id);
		if (!sidecar) return;

		if (sidecar.restartTimeouts) {
			clearTimeout(sidecar.restartTimeouts);
			sidecar.restartTimeouts = undefined;
		}

		sidecar.status = "stopped";

		if (sidecar.process && !sidecar.process.killed) {
			try {
				sidecar.process.kill("SIGTERM");
				// Give 1.5s to shut down gracefully, then SIGKILL
				setTimeout(() => {
					if (sidecar.process && !sidecar.process.killed) {
						sidecar.process.kill("SIGKILL");
					}
				}, 1500);
			} catch {}
		}

		sidecar.pid = undefined;
	}

	/**
	 * Restarts a sidecar.
	 */
	public async restart(id: string): Promise<SidecarProcessInfo> {
		await this.stop(id);
		const sidecar = this.sidecars.get(id);
		if (sidecar) {
			sidecar.restartCount = 0;
			sidecar.lastError = undefined;
		}
		return this.start(id);
	}

	/**
	 * Retrieves status of a specific sidecar.
	 */
	public getStatus(id: string): SidecarProcessInfo | undefined {
		const sidecar = this.sidecars.get(id);
		return sidecar ? this.toProcessInfo(sidecar) : undefined;
	}

	/**
	 * Lists all registered sidecars and their current health.
	 */
	public list(): SidecarProcessInfo[] {
		return Array.from(this.sidecars.values()).map(s => this.toProcessInfo(s));
	}

	/**
	 * Reads trailing logs for a sidecar.
	 */
	public async getLogs(id: string, maxLines = 100): Promise<string> {
		const sidecar = this.sidecars.get(id);
		if (!sidecar || !fs.existsSync(sidecar.logPath)) {
			return "";
		}

		try {
			const content = await fs.promises.readFile(sidecar.logPath, "utf-8");
			const lines = content.split("\n");
			return lines.slice(-maxLines).join("\n");
		} catch {
			return "";
		}
	}

	/**
	 * Gracefully stops all active sidecars (e.g. at shutdown).
	 */
	public async stopAll(): Promise<void> {
		for (const id of this.sidecars.keys()) {
			await this.stop(id);
		}
	}

	private spawnProcess(sidecar: ActiveSidecar): SidecarProcessInfo {
		const { config, logPath } = sidecar;

		try {
			const logFd = fs.openSync(logPath, "a");
			const env = { ...process.env, ...config.env };

			const child = spawn(config.command, config.args || [], {
				cwd: config.cwd || process.cwd(),
				env,
				stdio: ["ignore", logFd, logFd],
				detached: false,
			});

			sidecar.process = child;
			sidecar.pid = child.pid;
			sidecar.status = "running";
			sidecar.startedAt = Date.now();

			child.on("error", err => {
				sidecar.lastError = err.message;
				fs.appendFileSync(logPath, `\n[Sidecar Error] ${new Date().toISOString()}: ${err.message}\n`);
			});

			child.on("exit", (code, signal) => {
				fs.closeSync(logFd);
				const wasExpectedStop = sidecar.status === "stopped";
				if (wasExpectedStop) return;

				const maxRestarts = config.maxRestarts ?? 5;
				const policy = config.restartPolicy ?? "on-failure";
				const isFailure = code !== 0 || signal !== null;

				const shouldRestart =
					(policy === "always" || (policy === "on-failure" && isFailure)) && sidecar.restartCount < maxRestarts;

				if (shouldRestart) {
					sidecar.status = "restarting";
					sidecar.restartCount += 1;
					const backoffMs = Math.min(1000 * 2 ** (sidecar.restartCount - 1), 10000);

					fs.appendFileSync(
						logPath,
						`\n[Sidecar Supervisor] Process exited (${code ?? signal}). Restarting in ${backoffMs}ms (attempt ${sidecar.restartCount}/${maxRestarts})...\n`,
					);

					sidecar.restartTimeouts = setTimeout(() => {
						if (sidecar.status === "restarting") {
							this.spawnProcess(sidecar);
						}
					}, backoffMs);
				} else {
					sidecar.status = isFailure ? "crashed" : "stopped";
					sidecar.pid = undefined;
					sidecar.lastError = isFailure
						? `Process terminated with code ${code ?? signal} (Max restarts reached or policy disallowed)`
						: undefined;

					fs.appendFileSync(
						logPath,
						`\n[Sidecar Supervisor] Process finished (${code ?? signal}). Status: ${sidecar.status}.\n`,
					);
				}
			});

			return this.toProcessInfo(sidecar);
		} catch (err) {
			sidecar.status = "crashed";
			sidecar.lastError = err instanceof Error ? err.message : String(err);
			return this.toProcessInfo(sidecar);
		}
	}

	private toProcessInfo(sidecar: ActiveSidecar): SidecarProcessInfo {
		const now = Date.now();
		const uptimeSec =
			sidecar.status === "running" && sidecar.startedAt ? Math.floor((now - sidecar.startedAt) / 1000) : 0;

		return {
			id: sidecar.config.id,
			name: sidecar.config.name || sidecar.config.id,
			pid: sidecar.pid,
			status: sidecar.status,
			uptimeSec,
			restartCount: sidecar.restartCount,
			startedAt: sidecar.startedAt,
			lastError: sidecar.lastError,
			logPath: sidecar.logPath,
			config: sidecar.config,
		};
	}
}
