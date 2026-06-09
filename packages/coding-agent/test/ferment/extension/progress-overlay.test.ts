/**
 * Ferment progress overlay tests.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/extensibility/extensions/types.js";
import {
	clearProgressWidget,
	setProgressWidget,
	showProgressOverlay,
} from "../../../src/ferment/extension/progress-overlay.js";
import { clearActive, setActive } from "../../../src/ferment/extension/state.js";

function makeMockUI() {
	return {
		notify: mock(() => {}),
		confirm: mock(async () => true),
		select: mock(async () => undefined),
		input: mock(async () => undefined),
		onTerminalInput: () => () => {},
		setStatus: mock(() => {}),
		setWorkingMessage: () => {},
		setWidget: mock(() => {}),
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => {
			throw new Error("not implemented");
		},
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setEditorComponent: () => {},
		theme: {} as any,
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function makeCtx(): ExtensionCommandContext {
	return {
		ui: makeMockUI(),
		hasUI: true,
		cwd: "/tmp",
		getContextUsage: () => undefined,
		compact: async () => {},
		sessionManager: {} as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getSystemPrompt: () => [],
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		branch: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	} as unknown as ExtensionCommandContext;
}

function makeApi(): ExtensionAPI {
	return {
		sendMessage: mock(() => {}),
	} as unknown as ExtensionAPI;
}

function makeFerment() {
	return {
		id: "f-1",
		name: "Test",
		status: "active",
		activePhaseId: "p1",
		goal: "Build API",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [
			{
				id: "p1",
				index: 1,
				name: "Design",
				status: "active",
				goal: "Design API",
				steps: [
					{ id: "s1", index: 1, description: "Write spec", status: "done", summary: "" },
					{ id: "s2", index: 2, description: "Review spec", status: "running", summary: "" },
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	clearActive();
});

describe("showProgressOverlay", () => {
	test("notifies when no active ferment", async () => {
		const ctx = makeCtx();
		const api = makeApi();
		await showProgressOverlay(ctx, api);
		expect(ctx.ui.notify).toHaveBeenCalledWith("No active ferment.", "info");
		expect(api.sendMessage).not.toHaveBeenCalled();
	});

	test("shows select with phases and steps", async () => {
		setActive(makeFerment() as any);
		const ctx = makeCtx();
		(ctx.ui.select as any).mockImplementation(async (_title: string, options: any[]) => {
			return options[2]?.label ?? undefined;
		});
		const api = makeApi();

		await showProgressOverlay(ctx, api);

		expect(ctx.ui.select).toHaveBeenCalled();
		expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "ferment_progress_focus" }), {
			triggerTurn: true,
		});
	});

	test("does nothing when selection is cancelled", async () => {
		setActive(makeFerment() as any);
		const ctx = makeCtx();
		const api = makeApi();
		await showProgressOverlay(ctx, api);
		expect(api.sendMessage).not.toHaveBeenCalled();
	});
});

describe("setProgressWidget", () => {
	test("renders widget with phase/step counts and next action", () => {
		setActive(makeFerment() as any);
		const ui = makeMockUI();
		setProgressWidget(ui);
		expect(ui.setWidget).toHaveBeenCalledWith(
			"ferment-progress",
			expect.arrayContaining(["Test · active", "Phase 1/1", "Steps 1/2", "Next: complete_step"]),
			{ placement: "belowEditor" },
		);
	});

	test("returns silently when no active ferment", () => {
		const ui = makeMockUI();
		setProgressWidget(ui);
		expect(ui.setWidget).not.toHaveBeenCalled();
	});
});

describe("clearProgressWidget", () => {
	test("clears the ferment-progress widget", () => {
		const ui = makeMockUI();
		clearProgressWidget(ui);
		expect(ui.setWidget).toHaveBeenCalledWith("ferment-progress", undefined);
	});
});
