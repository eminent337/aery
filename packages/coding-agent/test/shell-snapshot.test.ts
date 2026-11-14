import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildExecutionEnvironment,
	captureShellSnapshot,
	loadLatestShellSnapshot,
	loadShellSnapshot,
} from "../src/utils/shell-snapshot";

describe("Shell Snapshot Subsystem", () => {
	const testDir = path.join(os.tmpdir(), `aery-snap-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("captures and loads shell snapshot cleanly", async () => {
		const customEnv = {
			USER: "testuser",
			PATH: "/custom/bin:/usr/bin",
			SHELL: "/bin/bash",
			CUSTOM_VAR: "custom_value",
			SHLVL: "2",
		};

		const snapshot = await captureShellSnapshot({
			id: "test-snap-1",
			cwd: "/workspace/project",
			env: customEnv,
		});

		expect(snapshot.id).toBe("test-snap-1");
		expect(snapshot.cwd).toBe("/workspace/project");
		expect(snapshot.shell).toBe("/bin/bash");
		expect(snapshot.path).toBe("/custom/bin:/usr/bin");
		expect(snapshot.variables.CUSTOM_VAR).toBe("custom_value");
		// Ephemeral SHLVL should be filtered out
		expect(snapshot.variables.SHLVL).toBeUndefined();

		const loaded = await loadShellSnapshot("test-snap-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.id).toBe("test-snap-1");
		expect(loaded?.variables.CUSTOM_VAR).toBe("custom_value");
	});

	it("builds merged execution environment with overrides", () => {
		const snapshot = {
			id: "snap-env",
			timestamp: Date.now(),
			cwd: "/app",
			shell: "/bin/zsh",
			path: "/opt/bin",
			variables: {
				FOO: "bar",
				BAZ: "qux",
			},
		};

		const env = buildExecutionEnvironment(snapshot, {
			BAZ: "overridden",
			EXTRA: "new_value",
		});

		expect(env.PATH).toBe("/opt/bin");
		expect(env.FOO).toBe("bar");
		expect(env.BAZ).toBe("overridden");
		expect(env.EXTRA).toBe("new_value");
	});

	it("resolves the latest shell snapshot", async () => {
		await captureShellSnapshot({ id: "snap-order-1", env: { PATH: "/p1" } });
		await Bun.sleep(15);
		await captureShellSnapshot({ id: "snap-order-2", env: { PATH: "/p2" } });

		const latest = await loadLatestShellSnapshot();
		expect(latest).not.toBeNull();
		expect(latest?.id).toBe("snap-order-2");
	});
});
