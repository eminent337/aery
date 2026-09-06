import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { DesktopControlTool } from "../src/tools/desktop-control";

describe("DesktopControlTool", () => {
	const tool = new DesktopControlTool();

	it("has correct tool metadata and schema", () => {
		expect(tool.name).toBe("desktop_control");
		expect(tool.approval).toBe("read");
		expect(tool.description).toContain("Desktop screen vision and window manager tool");
	});

	it("validates required parameters for focus and close actions", async () => {
		const res1 = await tool.execute("call_1", { action: "focus_window" });
		expect(res1.content[0].type).toBe("text");
		expect((res1.content[0] as { text: string }).text).toContain("query");

		const res2 = await tool.execute("call_2", { action: "close_window" });
		expect(res2.content[0].type).toBe("text");
		expect((res2.content[0] as { text: string }).text).toContain("query");

		const res3 = await tool.execute("call_3", { action: "switch_workspace" });
		expect(res3.content[0].type).toBe("text");
		expect((res3.content[0] as { text: string }).text).toContain("workspace");

		const res4 = await tool.execute("call_4", { action: "launch_app" });
		expect(res4.content[0].type).toBe("text");
		expect((res4.content[0] as { text: string }).text).toContain("command");
	});

	it("gets cursor position or returns structured result", async () => {
		const res = await tool.execute("call_5", { action: "cursor_pos" });
		expect(res.content[0].type).toBe("text");
		expect(res.details).toBeDefined();
	});

	it("lists open desktop windows under Hyprland", async () => {
		const res = await tool.execute("call_6", { action: "list_windows" });
		expect(res.content[0].type).toBe("text");
		expect(res.details).toBeDefined();
		const details = res.details as { windows?: unknown[] };
		expect(Array.isArray(details.windows)).toBe(true);
	});

	it("captures a screenshot with metadata", async () => {
		const res = await tool.execute("call_7", {
			action: "screenshot",
			target: "fullscreen",
			includeBase64: false,
		});
		expect(res.content[0].type).toBe("text");
		const details = res.details as { filePath?: string };
		if (details?.filePath) {
			expect(fs.existsSync(details.filePath)).toBe(true);
			// Clean up test file
			fs.rmSync(details.filePath, { force: true });
		}
	});
});
