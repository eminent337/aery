import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	ComputerUseTeachTool,
	computerUseTeachSchema,
	type WorkflowRecipe,
} from "../src/tools/computer-use-teach";

describe("Computer Use Teach Mode & Recipe Engine", () => {
	const testDir = path.join(os.tmpdir(), `aery-teach-test-${Date.now()}`);
	const textOf = (res: any) => (res.content[0] as any).text as string;

	beforeEach(async () => {
		await fs.promises.mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.promises.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("validates parameters schema for all teach actions", () => {
		const startParsed = computerUseTeachSchema.parse({
			action: "start_session",
			recipe_name: "Export Audio",
			description: "Export audio workflow in Audacity",
			app: "audacity",
		});
		expect(startParsed.action).toBe("start_session");
		expect(startParsed.recipe_name).toBe("Export Audio");

		const stepParsed = computerUseTeachSchema.parse({
			action: "record_step",
			step_type: "click",
			target: "File Menu",
			coords: [25, 45],
			description: "Click File in menubar",
		});
		expect(stepParsed.action).toBe("record_step");
		expect(stepParsed.coords).toEqual([25, 45]);

		const saveParsed = computerUseTeachSchema.parse({
			action: "save_recipe",
			recipe_name: "Export Audio",
		});
		expect(saveParsed.action).toBe("save_recipe");

		const listParsed = computerUseTeachSchema.parse({
			action: "list_recipes",
		});
		expect(listParsed.action).toBe("list_recipes");

		const replayParsed = computerUseTeachSchema.parse({
			action: "replay_recipe",
			recipe_id: "export-audio",
		});
		expect(replayParsed.action).toBe("replay_recipe");
	});

	it("executes teaching session lifecycle from start to save and list", async () => {
		const tool = new ComputerUseTeachTool({ storageDir: testDir });

		// 1. Start session
		const startRes = await tool.execute("call-1", {
			action: "start_session",
			recipe_name: "Login Workflow",
			description: "Log into internal developer dashboard",
			app: "firefox",
		});
		expect(startRes.isError).toBeFalsy();
		expect(textOf(startRes)).toContain("Started teaching session");

		// 2. Record click step
		const step1Res = await tool.execute("call-2", {
			action: "record_step",
			step_type: "click",
			target: "Username Field",
			coords: [200, 350],
			description: "Focus username field",
		});
		expect(step1Res.isError).toBeFalsy();
		expect(textOf(step1Res)).toContain("Step 1 recorded");

		// 3. Record type step
		const step2Res = await tool.execute("call-3", {
			action: "record_step",
			step_type: "type",
			text: "developer@example.com",
			description: "Enter username",
		});
		expect(step2Res.isError).toBeFalsy();
		expect(textOf(step2Res)).toContain("Step 2 recorded");

		// 4. Record key step
		const step3Res = await tool.execute("call-4", {
			action: "record_step",
			step_type: "key",
			keys: "Return",
			description: "Submit login form",
		});
		expect(step3Res.isError).toBeFalsy();
		expect(textOf(step3Res)).toContain("Step 3 recorded");

		// 5. Save recipe
		const saveRes = await tool.execute("call-5", {
			action: "save_recipe",
			recipe_name: "Login Workflow",
		});
		expect(saveRes.isError).toBeFalsy();
		expect(textOf(saveRes)).toContain("Recipe saved successfully");

		// 6. List recipes
		const listRes = await tool.execute("call-6", {
			action: "list_recipes",
		});
		expect(listRes.isError).toBeFalsy();
		expect(textOf(listRes)).toContain("login-workflow");
	});

	it("replays recorded workflow recipe", async () => {
		const tool = new ComputerUseTeachTool({ storageDir: testDir });

		await tool.execute("call-1", {
			action: "start_session",
			recipe_name: "Quick Key Sequence",
			description: "Send shortcut",
		});

		await tool.execute("call-2", {
			action: "record_step",
			step_type: "key",
			keys: "ctrl+s",
			description: "Save document",
		});

		await tool.execute("call-3", {
			action: "save_recipe",
			recipe_name: "Quick Save",
		});

		const replayRes = await tool.execute("call-4", {
			action: "replay_recipe",
			recipe_id: "quick-save",
		});
		expect(replayRes.isError).toBeFalsy();
		expect(textOf(replayRes)).toContain("Replayed 1 step");
	});
});
