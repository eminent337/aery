import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@aryee337/aery-tui";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution";
import { initTheme } from "../../../src/modes/theme/theme";

describe("ToolExecutionComponent duration telemetry", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const dummyUi = { requestRender() {} } as unknown as TUI;

	it("does not set durationMs while execution is partial", () => {
		const comp = new ToolExecutionComponent("custom_tool", { arg: 1 }, {}, undefined, dummyUi);
		expect(comp.durationMs).toBeUndefined();

		comp.updateResult({ content: [{ type: "text", text: "working..." }] }, true);
		expect(comp.durationMs).toBeUndefined();
	});

	it("records durationMs and renders duration badge upon completion", async () => {
		const comp = new ToolExecutionComponent("custom_tool", { arg: 1 }, {}, undefined, dummyUi);
		expect(comp.durationMs).toBeUndefined();

		// Wait 15ms so duration is non-zero
		await new Promise(resolve => setTimeout(resolve, 15));

		comp.updateResult({ content: [{ type: "text", text: "done" }] }, false);
		expect(typeof comp.durationMs).toBe("number");
		expect(comp.durationMs!).toBeGreaterThanOrEqual(10);

		const rendered = comp.render(80).join("\n");
		// Top bar should contain duration badge like (15ms) or (20ms)
		expect(rendered).toMatch(/\(\d+m?s\)/);
	});

	it("populates renderContext with durationMs and durationStr", async () => {
		const comp = new ToolExecutionComponent("bash", { command: "echo ok" }, {}, undefined, dummyUi);

		await new Promise(resolve => setTimeout(resolve, 15));
		comp.updateResult({ content: [{ type: "text", text: "ok\n" }] }, false);

		// Check that the top bar rendered includes the duration
		const rendered = comp.render(80).join("\n");
		expect(rendered).toMatch(/\(\d+m?s\)/);
	});

	it("passes durationStr to write tool header meta", async () => {
		const comp = new ToolExecutionComponent(
			"write",
			{ path: "test.txt", content: "hello world" },
			{},
			undefined,
			dummyUi,
		);

		await new Promise(resolve => setTimeout(resolve, 15));
		comp.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		const rendered = comp.render(80).join("\n");
		expect(rendered).toMatch(/\(\d+m?s\)/);
	});
});
