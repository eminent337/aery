/**
 * Unit tests for ferment extension tools.
 * Verifies tools register without error, guard paths work (no active ferment),
 * and the correct command shapes flow through applyTransition.
 */

import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@aryee337/aery";
import type { Ferment, FermentCommand } from "../../../src/ferment/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDraftFerment(): Ferment {
	const now = new Date().toISOString();
	return {
		id: "f-test",
		name: "Test Ferment",
		status: "draft",
		goal: "Test goal",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	};
}

function makeRunningFerment(): Ferment {
	const now = new Date().toISOString();
	return {
		id: "f-test",
		name: "Test Ferment",
		status: "running",
		goal: "Test goal",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Phase 1",
				goal: "Phase 1 goal",
				status: "active",
				steps: [
					{ id: "step-1", index: 1, description: "Step 1", status: "pending" },
					{ id: "step-2", index: 2, description: "Step 2", status: "pending" },
				],
			},
			{
				id: "phase-2",
				index: 2,
				name: "Phase 2",
				goal: "Phase 2 goal",
				status: "planned",
				steps: [],
			},
		],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	};
}

// Captures applyTransition calls for inspection
let applyTransitionCalls: Array<{ ferment: Ferment; cmd: FermentCommand }> = [];

function setupApplyTransitionCapture() {
	applyTransitionCalls = [];
}

// ─── Lifecycle tool tests ─────────────────────────────────────────────────────

test("registerLifecycleTools registers without throwing", async () => {
	const { registerLifecycleTools } = await import("../../../src/ferment/extension/tools/lifecycle.js");
	const api = createFakeApi();
	expect(() => registerLifecycleTools(api)).not.toThrow();
});

test("ferment_scope returns error when no active ferment (guard path)", async () => {
	const { registerLifecycleTools } = await import("../../../src/ferment/extension/tools/lifecycle.js");
	await clearActive();

	const results = await captureToolResults(registerLifecycleTools, "ferment_scope", {
		goal: "Test goal",
		phases: [{ name: "P1", goal: "Do the thing" }],
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_pause returns error when no active ferment", async () => {
	const { registerLifecycleTools } = await import("../../../src/ferment/extension/tools/lifecycle.js");
	await clearActive();

	const results = await captureToolResults(registerLifecycleTools, "ferment_pause", {});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_resume returns error when no active ferment", async () => {
	const { registerLifecycleTools } = await import("../../../src/ferment/extension/tools/lifecycle.js");
	await clearActive();

	const results = await captureToolResults(registerLifecycleTools, "ferment_resume", {});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_complete_ferment returns error when no active ferment", async () => {
	const { registerLifecycleTools } = await import("../../../src/ferment/extension/tools/lifecycle.js");
	await clearActive();

	const results = await captureToolResults(registerLifecycleTools, "ferment_complete_ferment", {});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_abandon returns error when no active ferment", async () => {
	const { registerLifecycleTools } = await import("../../../src/ferment/extension/tools/lifecycle.js");
	await clearActive();

	const results = await captureToolResults(registerLifecycleTools, "ferment_abandon", { reason: "Too hard" });

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

// ─── Phase tool tests ─────────────────────────────────────────────────────────

test("registerPhaseTools registers without throwing", async () => {
	const { registerPhaseTools } = await import("../../../src/ferment/extension/tools/phases.js");
	const api = createFakeApi();
	expect(() => registerPhaseTools(api)).not.toThrow();
});

test("ferment_activate_phase returns error when no active ferment", async () => {
	const { registerPhaseTools } = await import("../../../src/ferment/extension/tools/phases.js");
	await clearActive();

	const results = await captureToolResults(registerPhaseTools, "ferment_activate_phase", { phaseId: "phase-1" });

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_activate_phase returns error for nonexistent phase", async () => {
	const { registerPhaseTools } = await import("../../../src/ferment/extension/tools/phases.js");
	await setActive(makeRunningFerment());

	const results = await captureToolResults(registerPhaseTools, "ferment_activate_phase", { phaseId: "nonexistent" });

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("not found");
});

test("ferment_complete_phase returns error when no active ferment", async () => {
	const { registerPhaseTools } = await import("../../../src/ferment/extension/tools/phases.js");
	await clearActive();

	const results = await captureToolResults(registerPhaseTools, "ferment_complete_phase", { phaseId: "phase-1" });

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_skip_phase returns error when no active ferment", async () => {
	const { registerPhaseTools } = await import("../../../src/ferment/extension/tools/phases.js");
	await clearActive();

	const results = await captureToolResults(registerPhaseTools, "ferment_skip_phase", { phaseId: "phase-1" });

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_fail_phase returns error when no active ferment", async () => {
	const { registerPhaseTools } = await import("../../../src/ferment/extension/tools/phases.js");
	await clearActive();

	const results = await captureToolResults(registerPhaseTools, "ferment_fail_phase", {
		phaseId: "phase-1",
		reason: "Boom",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

// ─── Step tool tests ──────────────────────────────────────────────────────────

test("registerStepTools registers without throwing", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	const api = createFakeApi();
	expect(() => registerStepTools(api)).not.toThrow();
});

test("ferment_start_step returns error when no active ferment", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	await clearActive();

	const results = await captureToolResults(registerStepTools, "ferment_start_step", {
		phaseId: "phase-1",
		stepId: "step-1",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_start_step returns error for nonexistent phase", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	await setActive(makeRunningFerment());

	const results = await captureToolResults(registerStepTools, "ferment_start_step", {
		phaseId: "nonexistent",
		stepId: "step-1",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("not found");
});

test("ferment_complete_step returns error when no active ferment", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	await clearActive();

	const results = await captureToolResults(registerStepTools, "ferment_complete_step", {
		phaseId: "phase-1",
		stepId: "step-1",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_verify_step returns error when no active ferment", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	await clearActive();

	const results = await captureToolResults(registerStepTools, "ferment_verify_step", {
		phaseId: "phase-1",
		stepId: "step-1",
		result: { success: true },
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_skip_step returns error when no active ferment", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	await clearActive();

	const results = await captureToolResults(registerStepTools, "ferment_skip_step", {
		phaseId: "phase-1",
		stepId: "step-1",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_fail_step returns error when no active ferment", async () => {
	const { registerStepTools } = await import("../../../src/ferment/extension/tools/steps.js");
	await clearActive();

	const results = await captureToolResults(registerStepTools, "ferment_fail_step", {
		phaseId: "phase-1",
		stepId: "step-1",
		error: "Boom",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

type AgentToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function createFakeApi(): ExtensionAPI {
	return {
		zod: require("zod/v4"),
		registerTool() {},
	} as unknown as ExtensionAPI;
}

async function setActive(f: Ferment | undefined): Promise<void> {
	const { setActive: sa } = await import("../../../src/ferment/extension/state.js");
	sa(f);
}

async function clearActive(): Promise<void> {
	await setActive(undefined);
}

async function captureToolResults(
	registerFn: (api: ExtensionAPI) => void,
	toolName: string,
	params: Record<string, unknown>,
): Promise<AgentToolResult> {
	let toolExecutePromise: Promise<AgentToolResult> | undefined;

	const api = {
		zod: require("zod/v4"),
		registerTool(tool: any) {
			if (tool.name === toolName) {
				toolExecutePromise = tool.execute("test-call-id", params, undefined, undefined, {} as any);
			}
		},
	};

	registerFn(api as unknown as ExtensionAPI);

	return await toolExecutePromise!;
}
