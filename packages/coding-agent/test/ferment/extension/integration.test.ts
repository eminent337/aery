/**
 * Integration test — Ferment extension loaded via ExtensionAPI.
 * Simulates a full aery session lifecycle with a ferment workflow.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createFermentExtension } from "../../../src/ferment/extension/extension.js";
import { clearActive, getActive } from "../../../src/ferment/extension/state.js";

// Clear any residual state from parallel test runs
clearActive();

type EventRecord = { type: string; data: unknown };

function createMockApi(): {
	api: any;
	tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }>;
	events: EventRecord[];
	messages: Array<{ content: string; customType: string; display: boolean }>;
	status: Record<string, string | undefined>;
} {
	const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const events: EventRecord[] = [];
	const messages: Array<{ content: string; customType: string; display: boolean }> = [];
	const status: Record<string, string | undefined> = {};

	const api = {
		zod: require("zod/v4"),
		registerTool(tool: any) {
			tools.push(tool);
		},
		registerCommand(name: string, opts: any) {
			/* no-op */
		},
		registerShortcut(key: string, opts: any) {
			/* no-op */
		},
		on(event: string, handler: (...args: any[]) => void) {
			events.push({ type: event, data: handler });
		},
		sendMessage(msg: any, opts: any) {
			messages.push(msg);
		},
		setStatus(key: string, text: string | undefined) {
			status[key] = text;
		},
		ui: {
			setStatus(key: string, text: string | undefined) {
				status[key] = text;
			},
		},
	};

	return { api, tools, events, messages, status };
}

async function callTool(
	tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }>,
	name: string,
	params: Record<string, unknown>,
) {
	const tool = tools.find(t => t.name === name);
	if (!tool) throw new Error(`Tool not found: ${name}`);
	return tool.execute("test-id", params, undefined, undefined, {});
}

beforeEach(() => {
	clearActive();
});

describe("Ferment Extension Integration", () => {
	test("factory loads without error", () => {
		const { api } = createMockApi();
		const ext = createFermentExtension();
		expect(() => ext(api)).not.toThrow();
	});

	test("full lifecycle: scope → activate → start → complete → complete phase → complete ferment", async () => {
		await clearActive();
		const { api, tools, messages } = createMockApi();
		const ext = createFermentExtension();
		ext(api);

		// 1. Create draft ferment
		const newResult = await callTool(tools, "ferment_new", {
			goal: "Build auth system",
		});
		expect(newResult.isError).toBeFalsy();
		expect(getActive()?.status).toBe("draft");

		// 2. Scope the ferment
		const scopeResult = await callTool(tools, "ferment_scope", {
			goal: "Build auth system",
			title: "Auth System",
			phases: [
				{
					name: "Setup",
					goal: "Install deps",
					steps: [{ description: "Install JWT library" }],
				},
				{
					name: "Build",
					goal: "Create endpoints",
					steps: [{ description: "Add login route" }],
				},
			],
		});

		expect(scopeResult.isError).toBeFalsy();
		expect(getActive()?.status).toBe("planned");

		// 2. Activate first phase
		const activateResult = await callTool(tools, "ferment_activate_phase", {
			phaseId: (getActive()!.phases[0] as { id: string }).id,
		});
		expect(activateResult.isError).toBeFalsy();
		expect(getActive()?.status).toBe("running");

		// 3. Start step
		const phase = getActive()!.phases[0];
		const step = phase.steps[0];
		const startResult = await callTool(tools, "ferment_start_step", {
			phaseId: (phase as { id: string }).id,
			stepId: (step as { id: string }).id,
		});
		expect(startResult.isError).toBeFalsy();
		expect(getActive()!.phases[0].steps[0].status).toBe("running");

		// 4. Complete step
		const completeStepResult = await callTool(tools, "ferment_complete_step", {
			phaseId: (phase as { id: string }).id,
			stepId: (step as { id: string }).id,
		});
		expect(completeStepResult.isError).toBeFalsy();
		expect(getActive()!.phases[0].steps[0].status).toBe("done");

		// 5. Complete phase
		const completePhaseResult = await callTool(tools, "ferment_complete_phase", {
			phaseId: (phase as { id: string }).id,
		});
		expect(completePhaseResult.isError).toBeFalsy();
		expect(getActive()!.phases[0].status).toBe("completed");
		// 6. Verify phase 2 was auto-activated (settleAfterPhaseTerminal)
		const phase2 = getActive()!.phases[1];
		expect(phase2.status).toBe("active");

		// 7. Start + complete second step
		const step2 = phase2.steps[0];
		await callTool(tools, "ferment_start_step", {
			phaseId: (phase2 as { id: string }).id,
			stepId: (step2 as { id: string }).id,
		});
		await callTool(tools, "ferment_complete_step", {
			phaseId: (phase2 as { id: string }).id,
			stepId: (step2 as { id: string }).id,
		});

		// 8. Complete phase 2
		await callTool(tools, "ferment_complete_phase", {
			phaseId: (phase2 as { id: string }).id,
		});

		// 9. Complete ferment
		const completeFermentResult = await callTool(tools, "ferment_complete_ferment", {});
		expect(completeFermentResult.isError).toBeFalsy();
		expect(getActive()?.status).toBe("complete");
	});

	test("automated continuation sends nudge on turn_end", async () => {
		await clearActive();
		const { api, tools, events, messages } = createMockApi();
		const ext = createFermentExtension();
		ext(api);

		// Create draft, then scope and activate a phase
		await callTool(tools, "ferment_new", { goal: "Test" });
		await callTool(tools, "ferment_scope", {
			goal: "Test",
			phases: [{ name: "P1", goal: "G1", steps: [{ description: "S1" }] }],
		});

		const phase = getActive()!.phases[0];
		await callTool(tools, "ferment_activate_phase", {
			phaseId: (phase as { id: string }).id,
		});

		// Set policy to automated
		const { setContinuationPolicy } = await import("../../../src/ferment/extension/state.js");
		setContinuationPolicy("automated");

		// Trigger turn_end event
		const turnEndHandler = events.find((e: EventRecord) => e.type === "turn_end")?.data;
		expect(turnEndHandler).toBeDefined();
		(turnEndHandler as any)?.({}, {});
		await Promise.resolve();

		expect(messages.length).toBeGreaterThan(0);
		expect(messages[0].customType).toBe("ferment_continue");
	});
});
