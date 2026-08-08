import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@aryee337/aery-utils";
import { Settings } from "../src/config/settings";
import { AgentStorage } from "../src/session/agent-storage";
import { createSubagentSettings } from "../src/task/executor";

describe("AgentStorage model perf aggregates", () => {
	let tempDir: TempDir;

	afterEach(() => {
		if (tempDir) {
			tempDir.removeSync();
		}
	});

	it("keeps TTFT null when no sample reported one and uses full duration for TPS", async () => {
		tempDir = TempDir.createSync("@aery-subagent-perf-");
		const dbPath = path.join(tempDir.path(), "agent.sqlite");
		const storage = await AgentStorage.open(dbPath);

		await storage.recordModelPerf("test-model", {
			outputTokens: 100,
			durationMs: 2000,
		});

		const stats = storage.getModelPerf().get("test-model");
		expect(stats?.samples).toBe(1);
		expect(stats?.tps).toBeCloseTo(100000 / 2000, 5);
		expect(stats?.ttftMs).toBeUndefined();
	});

	it("records task subagent samples in the shared model performance aggregate", async () => {
		tempDir = TempDir.createSync("@aery-subagent-perf-");
		const dbPath = path.join(tempDir.path(), "agent.sqlite");
		const storage = await AgentStorage.open(dbPath);

		const parent = Settings.isolated({}, { storage });
		const subagent = createSubagentSettings(parent);

		await subagent.getStorage()?.recordModelPerf("opencode-go/deepseek-v4-flash", {
			outputTokens: 130,
			durationMs: 2989.23775,
			ttftMs: 2324.873,
		});

		const stats = parent.getStorage()?.getModelPerf().get("opencode-go/deepseek-v4-flash");
		expect(stats?.samples).toBe(1);
		expect(stats?.tps).toBeCloseTo(130000 / 2989.23775, 5);
		expect(stats?.ttftMs).toBeCloseTo(2324.873, 5);
	});
});
