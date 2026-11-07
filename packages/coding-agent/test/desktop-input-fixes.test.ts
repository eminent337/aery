import { describe, expect, it } from "bun:test";
import { specToYdotoolEvents, toXdotoolKeyName } from "../src/tools/live-input";
import { validateInjection } from "../src/tools/desktop-control";
import { DesktopAccessibilityTool } from "../src/tools/desktop-accessibility";

describe("Desktop Input & Accessibility Fixes", () => {
	it("resolves standard W3C and Anthropic key tokens in live-input", () => {
		const arrows = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
		for (const k of arrows) {
			const ev = specToYdotoolEvents(k);
			expect("error" in ev).toBe(false);
			expect(toXdotoolKeyName(k.toLowerCase())).toBeDefined();
		}

		const shortcuts = ["cmd+c", "command+v", "page_down", "del"];
		for (const k of shortcuts) {
			const ev = specToYdotoolEvents(k);
			expect("error" in ev).toBe(false);
		}
	});

	it("allows standalone keyboard actions without demanding continuous observation", () => {
		const res = validateInjection({
			action: "press_key",
			keys: "Escape",
			frame: null,
			focusedAddress: "0x1234",
			observation: { state: "missing", detail: "No continuous observation yet", ageMs: null },
		});
		expect(res.ok).toBe(true);

		const typeRes = validateInjection({
			action: "type_text",
			keys: "Hello World",
			frame: null,
			focusedAddress: "0x1234",
			observation: { state: "missing", detail: "No continuous observation yet", ageMs: null },
		});
		expect(typeRes.ok).toBe(true);
	});

	it("routes desktop_accessibility press action via fallback on Hyprland", async () => {
		const tool = new DesktopAccessibilityTool();
		const res = await tool.execute("call-test", { action: "press", key: "Escape" });
		expect(res.isError).toBeFalsy();
	});
});
