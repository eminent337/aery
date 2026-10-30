import { beforeAll, describe, expect, it } from "bun:test";
import { SubagentActivityHudComponent } from "../../../src/modes/components/subagent-hud";
import { initTheme } from "../../../src/modes/theme/theme";

describe("SubagentActivityHudComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders nothing when no subagents are active", () => {
		const hud = new SubagentActivityHudComponent();
		expect(hud.count).toBe(0);
		expect(hud.getSubagents()).toHaveLength(0);
		expect(hud.render(80)).toHaveLength(0);
	});

	it("renders active subagents with tool calls, intent, and badges", () => {
		const hud = new SubagentActivityHudComponent();
		hud.setSubagents([
			{
				id: "sub-1",
				agent: "Codebase Researcher",
				status: "running",
				currentTool: "search_web",
				currentToolArgs: JSON.stringify({ query: "vitest matchers" }),
			},
			{
				id: "sub-2",
				agent: "Database Debugger",
				status: "active",
				lastIntent: "Analyzing SQLite query plan",
			},
		]);

		expect(hud.count).toBe(2);
		const rendered = hud.render(80).join("\n");

		expect(rendered).toContain("Subagent Activity");
		expect(rendered).toContain("(2 active)");
		expect(rendered).toContain("[sub-1]");
		expect(rendered).toContain("Codebase Researcher");
		expect(rendered).toContain("search_web(query: vitest matchers)");

		expect(rendered).toContain("[sub-2]");
		expect(rendered).toContain("Database Debugger");
		expect(rendered).toContain("Analyzing SQLite query plan");
	});

	it("clears subagents correctly", () => {
		const hud = new SubagentActivityHudComponent();
		hud.setSubagents([
			{
				id: "worker-1",
				agent: "Worker",
				status: "running",
			},
		]);
		expect(hud.count).toBe(1);

		hud.clearSubagents();
		expect(hud.count).toBe(0);
		expect(hud.render(80)).toHaveLength(0);
	});
});
