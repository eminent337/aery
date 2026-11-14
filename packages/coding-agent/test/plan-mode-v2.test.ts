import { describe, expect, it } from "bun:test";
import { EnterPlanModeTool, ExitPlanModeTool } from "../src/tools/plan-mode";

describe("Plan Mode V2 Protocol", () => {
	it("should enter plan mode with instructions and focus", async () => {
		let state = { enabled: false, planFilePath: "" };
		const mockSession: any = {
			getPlanModeState: () => state,
		};

		const enterTool = new EnterPlanModeTool(mockSession);
		const result = await enterTool.execute("call-1", { focus: "Refactor database layer" });

		expect(state.enabled).toBe(true);
		expect(result.details.active).toBe(true);
		expect(result.details.focus).toBe("Refactor database layer");
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("Refactor database layer");
		expect(result.content[0].text).toContain("read-only exploration");
	});

	it("should exit plan mode and submit plan with DO_NOT_COMPACT_THIS tag", async () => {
		let state = { enabled: true, planFilePath: "" };
		const mockSession: any = {
			getPlanModeState: () => state,
		};

		const exitTool = new ExitPlanModeTool(mockSession);
		const result = await exitTool.execute("call-2", {
			title: "migration-plan",
			plan: "1. Create table\n2. Add indexes\n3. Run migration",
		});

		expect(state.enabled).toBe(false);
		expect(result.details.approved).toBe(true);
		expect(result.details.plan).toContain("Create table");
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("<DO_NOT_COMPACT_THIS>");
		expect(result.content[0].text).toContain("Create table");
	});
});
