import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuardsExtension } from "./guards-extension";
import type { ExtensionAPI, ToolExecutionEndEvent, TurnEndEvent, TurnStartEvent } from "./types";

function createMockApi(): ExtensionAPI & {
	emitted: Array<{ customType: string; text: string }>;
	handlers: Record<string, Array<(event: unknown) => void>>;
} {
	const emitted: Array<{ customType: string; text: string }> = [];
	const handlers: Record<string, Array<(event: unknown) => void>> = {};

	return {
		emitted,
		handlers,
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		typebox: {} as never,
		zod: {} as never,
		aery: {} as never,
		on(event: string, handler: (event: unknown) => void) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		sendMessage(
			message: { customType: string; content: Array<{ type: string; text: string }> },
			_opts?: { deliverAs?: string },
		) {
			emitted.push({ customType: message.customType, text: message.content[0]?.text ?? "" });
		},
		sendUserMessage: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		exec: vi.fn(),
		sessionId: "test-session",
		extensionName: "guards",
	} as unknown as ExtensionAPI & {
		emitted: Array<{ customType: string; text: string }>;
		handlers: Record<string, Array<(event: unknown) => void>>;
	};
}

type MockApi = ExtensionAPI & {
	emitted: Array<{ customType: string; text: string }>;
	handlers: Record<string, Array<(event: unknown) => void>>;
};

function emitToolEnd(api: MockApi, toolName: string, isError: boolean, result: unknown) {
	const handler = api.handlers.tool_execution_end?.[0];
	handler?.({
		type: "tool_execution_end",
		toolCallId: `tc-${Date.now()}`,
		toolName,
		result,
		isError,
	} as ToolExecutionEndEvent);
}

function emitTurnStart(api: MockApi) {
	const handler = api.handlers.turn_start?.[0];
	handler?.({ type: "turn_start" } as TurnStartEvent);
}

function emitTurnEnd(api: MockApi) {
	const handler = api.handlers.turn_end?.[0];
	handler?.({ type: "turn_end", message: {} } as TurnEndEvent);
}

describe("guards-extension", () => {
	let api: MockApi;

	beforeEach(() => {
		api = createMockApi();
		const ext = createGuardsExtension({
			loopGuard: { consecutiveThreshold: 3 },
			explorationGuard: { hypothesisThreshold: 2, steerThreshold: 3 },
		});
		ext(api);
	});

	it("loop guard: warns on 3 consecutive identical tool calls", () => {
		emitToolEnd(api, "read", false, "output-a");
		emitToolEnd(api, "read", false, "output-a");
		emitToolEnd(api, "read", false, "output-a");

		const loopSteers = api.emitted.filter(e => e.customType === "loop-guard-steer");
		expect(loopSteers.length).toBeGreaterThanOrEqual(1);
		expect(loopSteers[0].text).toContain("Loop guard warning");
	});

	it("loop guard: resets on different tool", () => {
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "edit", false, "out"); // breaks pattern
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "read", false, "out");

		const loopSteers = api.emitted.filter(e => e.customType === "loop-guard-steer");
		expect(loopSteers.length).toBe(0);
	});

	it("exploration guard: warns at hypothesis threshold", () => {
		for (let i = 0; i < 2; i++) {
			emitTurnStart(api);
			emitToolEnd(api, "read", false, "out");
			emitTurnEnd(api);
		}

		const expSteers = api.emitted.filter(e => e.customType === "exploration-guard-steer");
		expect(expSteers.length).toBe(1);
		expect(expSteers[0].text).toContain("2 consecutive read-only turns");
	});

	it("exploration guard: resets on write tool", () => {
		emitTurnStart(api);
		emitToolEnd(api, "read", false, "out");
		emitTurnEnd(api);

		emitTurnStart(api);
		emitToolEnd(api, "edit", false, "out");
		emitTurnEnd(api);

		emitTurnStart(api);
		emitToolEnd(api, "read", false, "out");
		emitTurnEnd(api);

		const expSteers = api.emitted.filter(e => e.customType === "exploration-guard-steer");
		expect(expSteers.length).toBe(0);
	});

	it("resets all guards on session_start", () => {
		// Fire some tool calls first
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "read", false, "out");

		// Now fire session_start
		const handler = api.handlers.session_start?.[0];
		handler?.({ type: "session_start" });

		// After reset, no new steers should fire
		api.emitted.length = 0;
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "read", false, "out");
		emitToolEnd(api, "read", false, "out");

		// Should get a new warn (fresh guard) but not terminate
		const loopSteers = api.emitted.filter(e => e.customType === "loop-guard-steer");
		expect(loopSteers.length).toBeGreaterThanOrEqual(1);
	});

	it("budget retry guard: records exhaustion on task tool error", () => {
		emitToolEnd(api, "task", true, "error: token_budget exceeded for agent");

		// No steer message expected — budget retry guard tracks internally
		const budgetSteers = api.emitted.filter(e => e.customType.includes("budget"));
		expect(budgetSteers.length).toBe(0);
	});
});
