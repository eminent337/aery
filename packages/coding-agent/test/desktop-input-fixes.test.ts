import { describe, expect, it } from "bun:test";
import { specToYdotoolEvents, toXdotoolKeyName, ydoWheelScroll } from "../src/tools/live-input";
import { desktopControlSchema, validateInjection } from "../src/tools/desktop-control";
import { DesktopAccessibilityTool, desktopAccessibilitySchema } from "../src/tools/desktop-accessibility";
import { typeTextSchema, scrollAtSchema } from "../src/tools/agy-computer-use";

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

		const pasteRes = validateInjection({
			action: "paste",
			keys: "Pasted text",
			frame: null,
			focusedAddress: "0x1234",
		});
		expect(pasteRes.ok).toBe(true);
	});

	it("generates correct ydotool relative wheel events with ydoWheelScroll", () => {
		const downSteps = ydoWheelScroll("down", 3);
		expect(downSteps.length).toBe(3);
		expect(downSteps[0]).toEqual(["ydotool", "mousemove", "-w", "--", "0", "-1"]);

		const upSteps = ydoWheelScroll("up", 2);
		expect(upSteps.length).toBe(2);
		expect(upSteps[0]).toEqual(["ydotool", "mousemove", "-w", "--", "0", "1"]);

		const leftSteps = ydoWheelScroll("left", 1);
		expect(leftSteps[0]).toEqual(["ydotool", "mousemove", "-w", "--", "-1", "0"]);

		const rightSteps = ydoWheelScroll("right", 1);
		expect(rightSteps[0]).toEqual(["ydotool", "mousemove", "-w", "--", "1", "0"]);
	});

	it("validates type_text and scroll_at schemas accept click-to-focus and coordinates", () => {
		const parsedType = typeTextSchema.parse({
			text: "hello input",
			x: 500,
			y: 300,
			click_first: true,
			target: "Username",
		});
		expect(parsedType.x).toBe(500);
		expect(parsedType.y).toBe(300);
		expect(parsedType.click_first).toBe(true);
		expect(parsedType.target).toBe("Username");

		const parsedScroll = scrollAtSchema.parse({
			x: 200,
			y: 400,
			direction: "down",
			count: 5,
			click_to_focus: true,
			target: "Sidebar",
		});
		expect(parsedScroll.x).toBe(200);
		expect(parsedScroll.y).toBe(400);
		expect(parsedScroll.click_to_focus).toBe(true);
		expect(parsedScroll.target).toBe("Sidebar");

		const parsedDesktop = desktopControlSchema.parse({
			action: "paste",
			text: "Clipboard content",
			x: 250,
			y: 350,
			click_first: true,
		});
		expect(parsedDesktop.action).toBe("paste");
		expect(parsedDesktop.click_first).toBe(true);
	});

	it("validates desktopAccessibilitySchema accepts select with ref and option value", () => {
		const parsed = desktopAccessibilitySchema.parse({
			action: "select",
			ref: "@s123:e4",
			text: "Option A",
			click_first: true,
		});
		expect(parsed.action).toBe("select");
		expect(parsed.ref).toBe("@s123:e4");
		expect(parsed.text).toBe("Option A");
		expect(parsed.click_first).toBe(true);
	});

	it("routes desktop_accessibility press action via fallback on Hyprland", async () => {
		const tool = new DesktopAccessibilityTool();
		const res = await tool.execute("call-test", { action: "press", key: "Escape" });
		expect(res.isError).toBeFalsy();
	});
});
