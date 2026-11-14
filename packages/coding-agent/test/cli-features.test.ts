import { beforeEach, describe, expect, it } from "bun:test";
import { FeatureManager, KNOWN_FEATURES } from "../src/config/features";
import { Settings } from "../src/config/settings";

describe("Features Management & CLI", () => {
	let settings: Settings;
	let manager: FeatureManager;

	beforeEach(() => {
		settings = Settings.isolated();
		manager = new FeatureManager(settings);
	});

	it("lists all known features with defaults", () => {
		const list = manager.list();
		expect(list.length).toBe(KNOWN_FEATURES.length);

		const swarmFeat = list.find(f => f.name === "swarm");
		expect(swarmFeat).toBeDefined();
		expect(swarmFeat?.stage).toBe("stable");
		expect(swarmFeat?.effective).toBe(true);

		const codeModeFeat = list.find(f => f.name === "code_mode");
		expect(codeModeFeat).toBeDefined();
		expect(codeModeFeat?.stage).toBe("experimental");
		expect(codeModeFeat?.effective).toBe(false);
	});

	it("enables and disables features cleanly", async () => {
		expect(manager.isEnabled("code_mode")).toBe(false);

		const ok = await manager.set("code_mode", true);
		expect(ok).toBe(true);
		expect(manager.isEnabled("code_mode")).toBe(true);

		await manager.set("code_mode", false);
		expect(manager.isEnabled("code_mode")).toBe(false);
	});

	it("rejects unknown features safely", async () => {
		const ok = await manager.set("non_existent_feature", true);
		expect(ok).toBe(false);
		expect(manager.get("non_existent_feature")).toBeUndefined();
	});
});
