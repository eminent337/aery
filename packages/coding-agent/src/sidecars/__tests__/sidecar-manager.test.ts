import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SidecarManager } from "../sidecar-manager";
import type { SidecarConfig } from "../types";

describe("Sidecar Manager & Supervisor (ported from agy)", () => {
	let testDataDir: string;
	let manager: SidecarManager;

	beforeEach(() => {
		testDataDir = path.join(os.tmpdir(), `aery-sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		fs.mkdirSync(testDataDir, { recursive: true });
		manager = new SidecarManager(testDataDir);
	});

	afterEach(async () => {
		await manager.stopAll();
		try {
			fs.rmSync(testDataDir, { recursive: true, force: true });
		} catch {}
	});

	it("registers and starts a sidecar, logging stdout to disk", async () => {
		const config: SidecarConfig = {
			id: "echo-worker",
			command: "bash",
			args: ["-c", "echo 'Sidecar worker active' && sleep 0.05"],
			restartPolicy: "never",
		};

		manager.register(config);
		const initialList = manager.list();
		expect(initialList.length).toBe(1);
		expect(initialList[0].status).toBe("stopped");

		const started = await manager.start("echo-worker");
		expect(started.status).toBe("running");
		expect(started.pid).toBeDefined();

		// Wait briefly for execution and log flush
		await Bun.sleep(120);

		const logs = await manager.getLogs("echo-worker");
		expect(logs).toContain("Sidecar worker active");

		const status = manager.getStatus("echo-worker");
		expect(status?.status).toBe("stopped");
	});

	it("discovers sidecar.json from workspace .agents/sidecars directory", async () => {
		const fakeWorkspace = path.join(testDataDir, "workspace");
		const sidecarDir = path.join(fakeWorkspace, ".agents", "sidecars", "metrics-collector");
		fs.mkdirSync(sidecarDir, { recursive: true });

		const sidecarJson = {
			name: "Metrics Collector",
			command: "bash",
			args: ["-c", "echo 'collecting metrics'"],
			restart_policy: "never",
		};
		fs.writeFileSync(path.join(sidecarDir, "sidecar.json"), JSON.stringify(sidecarJson));

		const discovered = await manager.discover(fakeWorkspace);
		expect(discovered.length).toBe(1);
		expect(discovered[0].id).toBe("metrics-collector");
		expect(discovered[0].name).toBe("Metrics Collector");
	});

	it("supervises and restarts crashing processes on-failure", async () => {
		const markerFile = path.join(testDataDir, "crash-counter.txt");

		const config: SidecarConfig = {
			id: "failing-worker",
			command: "bash",
			args: ["-c", `echo 'run' >> "${markerFile}"; exit 1`],
			restartPolicy: "on-failure",
			maxRestarts: 2,
		};

		manager.register(config);
		await manager.start("failing-worker");

		// Wait for first crash and supervisor backoff restart
		await Bun.sleep(1200);

		const logs = await manager.getLogs("failing-worker");
		expect(logs).toContain("[Sidecar Supervisor]");
		const status = manager.getStatus("failing-worker");
		expect(status?.restartCount).toBeGreaterThan(0);
	});
});
