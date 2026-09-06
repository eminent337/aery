import { describe, expect, it } from "bun:test";
import { TerminalPaneTool } from "../src/tools/terminal-pane";

describe("TerminalPaneTool", () => {
	const tool = new TerminalPaneTool();

	it("has correct tool metadata and schema", () => {
		expect(tool.name).toBe("terminal_pane");
		expect(tool.approval).toBe("exec");
		expect(tool.description).toContain("terminal panes and windows");
	});

	it("validates required parameters for run action", async () => {
		// Missing paneId
		const res1 = await tool.execute("call_1", {
			action: "run",
			command: "echo test",
		});
		expect(res1.content[0].type).toBe("text");
		expect(res1.content[0].text).toContain("paneId is required");

		// Missing command
		const res2 = await tool.execute("call_2", {
			action: "run",
			paneId: "%1",
		});
		expect(res2.content[0].type).toBe("text");
		expect(res2.content[0].text).toContain("command is required");
	});

	it("validates required parameters for read action", async () => {
		const res = await tool.execute("call_3", {
			action: "read",
		});
		expect(res.content[0].type).toBe("text");
		expect(res.content[0].text).toContain("paneId is required");
	});

	it("validates required parameters for close action", async () => {
		const res = await tool.execute("call_4", {
			action: "close",
		});
		expect(res.content[0].type).toBe("text");
		expect(res.content[0].text).toContain("paneId is required");
	});

	it("lists panes gracefully when no panes exist", async () => {
		const res = await tool.execute("call_5", {
			action: "list",
		});
		expect(res.content[0].type).toBe("text");
		// Either empty or active tmux panes if running inside tmux
		expect(res.details).toBeDefined();
	});
});
