import { describe, expect, it } from "bun:test";
import {
	QuickLauncherTool,
	quickLauncherSchema,
} from "../src/tools/quick-launcher";

describe("Global Quick Launcher HUD Tool", () => {
	it("validates parameters schema for all quick launcher actions", () => {
		const statusParsed = quickLauncherSchema.parse({
			action: "status",
		});
		expect(statusParsed.action).toBe("status");

		const configParsed = quickLauncherSchema.parse({
			action: "configure",
			hotkey: "Super+Space",
			position: "top",
			auto_dismiss: true,
		});
		expect(configParsed.hotkey).toBe("Super+Space");
		expect(configParsed.position).toBe("top");
		expect(configParsed.auto_dismiss).toBe(true);

		const openParsed = quickLauncherSchema.parse({
			action: "open",
		});
		expect(openParsed.action).toBe("open");

		const dispatchParsed = quickLauncherSchema.parse({
			action: "dispatch_prompt",
			prompt: "Check system health",
		});
		expect(dispatchParsed.prompt).toBe("Check system health");

		const dismissParsed = quickLauncherSchema.parse({
			action: "dismiss",
		});
		expect(dismissParsed.action).toBe("dismiss");
	});

	it("manages quick launcher lifecycle and state transitions", async () => {
		const tool = new QuickLauncherTool();
		const textOf = (res: any) => (res.content[0] as any).text as string;

		// 1. Initial status
		const initialRes = await tool.execute("call-1", { action: "status" });
		expect(initialRes.isError).toBeFalsy();
		expect(textOf(initialRes)).toContain("visible: false");

		// 2. Configure hotkey
		const configRes = await tool.execute("call-2", {
			action: "configure",
			hotkey: "Ctrl+Space",
			position: "center",
		});
		expect(configRes.isError).toBeFalsy();
		expect(textOf(configRes)).toContain("Ctrl+Space");

		// 3. Open HUD
		const openRes = await tool.execute("call-3", { action: "open" });
		expect(openRes.isError).toBeFalsy();
		expect(textOf(openRes)).toContain("Quick Launcher HUD opened");

		// 4. Verify status is open
		const statusOpen = await tool.execute("call-4", { action: "status" });
		expect(textOf(statusOpen)).toContain("visible: true");

		// 5. Dispatch prompt
		const dispatchRes = await tool.execute("call-5", {
			action: "dispatch_prompt",
			prompt: "Summarize active workspace",
		});
		expect(dispatchRes.isError).toBeFalsy();
		expect(textOf(dispatchRes)).toContain("Dispatched prompt");

		// 6. Dismiss HUD
		const dismissRes = await tool.execute("call-6", { action: "dismiss" });
		expect(dismissRes.isError).toBeFalsy();
		expect(textOf(dismissRes)).toContain("Quick Launcher HUD dismissed");
	});
});
