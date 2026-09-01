import { describe, expect, it } from "bun:test";
import { onPrivacyPolicyChanged, Settings } from "../src/config/settings";

describe("privacy settings hooks", () => {
	it("fires onPrivacyPolicyChanged when a privacy setting is set", async () => {
		const settings = await Settings.isolated({ inMemory: true } as never);
		let fired = 0;
		const unsub = onPrivacyPolicyChanged(() => fired++);
		settings.set("privacy.firewall.enabled", false as never);
		settings.set("privacy.firewall.mode", "warn" as never);
		settings.set("privacy.firewall.extraDataCollecting", ["a/b"] as never);
		settings.set("privacy.firewall.allowlist", ["c/d"] as never);
		expect(fired).toBe(4);
		unsub();
		settings.set("privacy.firewall.enabled", true as never);
		expect(fired).toBe(4); // no fire after unsubscribe
	});
});
