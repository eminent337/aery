import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "../../../src/extensibility/extensions/types.js";
import { registerFermentCommands } from "../../../src/ferment/extension/commands.js";
import {
	clearActive,
	getActive,
	getContinuationPolicy,
	setActive,
	setContinuationPolicy,
} from "../../../src/ferment/extension/state.js";
import { FermentStore } from "../../../src/ferment/store.js";
import type { Ferment } from "../../../src/ferment/types.js";

// Clear any residual state from parallel test runs
clearActive();

const originalOpen = FermentStore.open;
afterEach(() => {
	clearActive();
	FermentStore.open = originalOpen;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockUI(
	overrides: Partial<{
		notify: ReturnType<typeof mock>;
		confirm: ReturnType<typeof mock>;
		select: ReturnType<typeof mock>;
		input: ReturnType<typeof mock>;
	}> = {},
): ExtensionUIContext {
	return {
		notify: mock(() => {}),
		confirm: mock(async () => true),
		select: mock(async () => undefined),
		input: mock(async () => undefined),
		...overrides,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
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

function makeMockContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	const ui = makeMockUI();
	return {
		ui,
		hasUI: true,
		cwd: "/tmp/test",
		sessionManager: {} as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getSystemPrompt: () => [],
		getContextUsage: () => undefined,
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		branch: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
		compact: async () => {},
		...overrides,
	} as ExtensionCommandContext;
}

function makeMockAPI(overrides: Partial<ExtensionAPI> = {}): ExtensionAPI {
	return {
		logger: {} as any,
		typebox: {} as any,
		zod: {} as any,
		aery: {} as any,
		on: mock(() => {}),
		registerTool: mock(() => {}),
		registerCommand: mock(() => {}),
		registerShortcut: mock(() => {}),
		registerFlag: mock(() => {}),
		setLabel: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerAssistantThinkingRenderer: () => {},
		sendMessage: mock(() => {}),
		sendUserMessage: mock(() => {}),
		appendEntry: mock(() => {}),
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) as any,
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
		registerProvider: () => {},
		events: {} as any,
		...overrides,
	};
}

function makeTestFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "f-test",
		name: "Test Ferment",
		status: "running",
		goal: "Test goal",
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Phase One",
				goal: "Do things",
				status: "active",
				steps: [{ id: "step-1", index: 1, description: "Step one", status: "pending" }],
			},
		],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("registerFermentCommands", () => {
	test("registers the ferment command", () => {
		const api = makeMockAPI();
		registerFermentCommands(api);
		expect(api.registerCommand).toHaveBeenCalledWith(
			"ferment",
			expect.objectContaining({ description: "Ferment workflow commands" }),
		);
	});

	test("registers the F6 shortcut", () => {
		const api = makeMockAPI();
		registerFermentCommands(api);
		expect(api.registerShortcut).toHaveBeenCalledWith(
			"f6",
			expect.objectContaining({ description: "Toggle ferment continuation policy" }),
		);
	});
});

describe("/ferment pause", () => {
	test("notifies when no active ferment", async () => {
		setActive(undefined);
		setContinuationPolicy("manual");

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("pause", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No active ferment to pause.", "warning");
	});

	test("notifies when already paused", async () => {
		setActive(makeTestFerment({ status: "paused" }));
		setContinuationPolicy("manual");

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("pause", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already paused"), "info");
	});
});

describe("/ferment resume", () => {
	test("notifies when no active ferment", async () => {
		setActive(undefined);

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("resume", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No active ferment to resume.", "warning");
	});

	test("notifies when not paused", async () => {
		setActive(makeTestFerment({ status: "running" }));

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("resume", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not paused"), "info");
	});

	test("sends nudge message when resuming", async () => {
		setActive(makeTestFerment({ status: "paused" }));

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("resume", ctx);

		expect(api.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_resume", display: false }),
			expect.objectContaining({ triggerTurn: true }),
		);
	});
});

describe("/ferment progress", () => {
	test("notifies when no active ferment", async () => {
		setActive(undefined);

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("progress", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No active ferment.", "info");
	});

	test("shows active ferment status via progress overlay", async () => {
		setActive(makeTestFerment({ name: "MyFerment", status: "running" }));

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("progress", ctx);

		// Should open select overlay instead of plain notify
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("MyFerment"), expect.any(Array));
	});
});

describe("/ferment policy", () => {
	test("toggles from manual to automated", async () => {
		setContinuationPolicy("manual");

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("policy", ctx);

		expect(getContinuationPolicy()).toBe("automated");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("automated"), "info");
	});

	test("toggles from automated to manual", async () => {
		setContinuationPolicy("automated");

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("policy", ctx);

		expect(getContinuationPolicy()).toBe("manual");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("manual"), "info");
	});
});

describe("F6 shortcut", () => {
	test("toggles continuation policy", () => {
		setContinuationPolicy("manual");

		const api = makeMockAPI();
		registerFermentCommands(api);

		const shortcutHandler = (api.registerShortcut as any).mock.calls[0][1].handler;
		const ctx = makeMockContext();
		shortcutHandler(ctx);

		expect(getContinuationPolicy()).toBe("automated");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("automated"), "info");
	});
});

describe("/ferment one-shot", () => {
	test("creates minimal ferment and sets policy to automated", async () => {
		clearActive();
		setContinuationPolicy("manual");

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("one-shot Fix the login bug", ctx);

		const active = getActive();
		expect(active).not.toBeUndefined();
		expect(active?.name).toBe("One-shot");
		expect(active?.goal).toBe("Fix the login bug");
		expect(active?.status).toBe("running");
		expect(active?.phases).toHaveLength(1);
		expect(active?.phases[0].name).toBe("Work");
		expect(active?.phases[0].status).toBe("active");
		expect(active?.activePhaseId).toBeDefined();
		expect(getContinuationPolicy()).toBe("automated");
		expect(ctx.ui.notify).toHaveBeenCalledWith(`One-shot ferment started.`, "info");

		// Verify step is started (running, not pending)
		const step = active?.phases[0].steps[0];
		expect(step).toBeDefined();
		expect(step?.status).toBe("running");
		expect(step?.startedAt).toBeDefined();
		expect(step?.description).toBe("Fix the login bug");

		// Verify a nudge message was sent to trigger the agent
		expect(api.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_one_shot",
				display: false,
			}),
			{ triggerTurn: true },
		);
	});

	test("notifies usage when goal is empty", async () => {
		clearActive();
		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("one-shot", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /ferment one-shot <goal>", "info");
		expect(getActive()).toBeUndefined();
	});

	test("sets step status to running and includes goal in description", async () => {
		clearActive();
		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("one-shot Refactor database layer", ctx);

		const active = getActive();
		expect(active).not.toBeUndefined();
		expect(active?.phases[0].steps).toHaveLength(1);

		const step = active!.phases[0].steps[0];
		expect(step.id).toBe("step-1");
		expect(step.index).toBe(1);
		expect(step.description).toBe("Refactor database layer");
		expect(step.status).toBe("running");
		expect(step.startedAt).toBeDefined();
	});

	test("creates ferment with expected phase structure", async () => {
		clearActive();
		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("one-shot Add unit tests", ctx);

		const active = getActive();
		expect(active).not.toBeUndefined();

		const phase = active!.phases[0];
		expect(phase.id).toBe("phase-1");
		expect(phase.index).toBe(1);
		expect(phase.name).toBe("Work");
		expect(phase.goal).toBe("Add unit tests");
		expect(phase.status).toBe("active");
		expect(phase.startedAt).toBeDefined();
		expect(phase.steps).toHaveLength(1);
	});
});

describe("/ferment list", () => {
	test("notifies when empty", async () => {
		clearActive();

		const mockStore = {
			listByWorktree: mock(() => []),
			save: mock(() => {}),
			get: mock(() => null),
			delete: mock(() => {}),
		};

		const api = makeMockAPI({
			aery: { store: mock(() => mockStore) } as any,
		});
		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("list", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No ferments in this worktree.", "info");
	});

	test("shows select when ferments exist", async () => {
		clearActive();

		const ferments = [
			makeTestFerment({ id: "f-1", name: "Ferment One", status: "running" }),
			makeTestFerment({ id: "f-2", name: "Ferment Two", status: "paused" }),
		];

		const mockStore = {
			listByWorktree: mock(() => ferments),
			save: mock(() => {}),
			get: mock(() => null),
			delete: mock(() => {}),
		};

		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const selectMock = mock(async () => "Ferment One (running)");
		const api = makeMockAPI();
		const ctx = makeMockContext({ ui: makeMockUI({ select: selectMock }) });
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("list", ctx);

		expect(selectMock).toHaveBeenCalledWith(
			"Ferments:",
			expect.arrayContaining([
				expect.objectContaining({ label: "Ferment One (running)" }),
				expect.objectContaining({ label: "Ferment Two (paused)" }),
			]),
		);
		expect(getActive()?.name).toBe("Ferment One");
	});
});

describe("/ferment switch", () => {
	test("warns when not found", async () => {
		clearActive();

		const mockStore = {
			listByWorktree: mock(() => []),
			save: mock(() => {}),
			delete: mock(() => {}),
		};

		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("switch nonexistent", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No ferment matching 'nonexistent'.", "warning");
	});

	test("switches by id prefix", async () => {
		clearActive();

		const ferments = [makeTestFerment({ id: "f-abc-123", name: "My Ferment", status: "running" })];

		const mockStore = {
			listByWorktree: mock(() => ferments),
			save: mock(() => {}),
			delete: mock(() => {}),
		};

		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("switch f-abc", ctx);

		expect(getActive()?.name).toBe("My Ferment");
		expect(ctx.ui.notify).toHaveBeenCalledWith('Switched to ferment "My Ferment" (running).', "info");
	});

	test("switches by name match", async () => {
		clearActive();

		const ferments = [makeTestFerment({ id: "f-xyz", name: "Backend API Fix", status: "paused" })];

		const mockStore = {
			listByWorktree: mock(() => ferments),
			save: mock(() => {}),
			delete: mock(() => {}),
		};

		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("switch backend", ctx);

		expect(getActive()?.name).toBe("Backend API Fix");
		expect(ctx.ui.notify).toHaveBeenCalledWith('Switched to ferment "Backend API Fix" (paused).', "info");
	});
});

describe("/ferment delete", () => {
	test("warns when not found", async () => {
		clearActive();

		const mockStore = {
			listByWorktree: mock(() => []),
			save: mock(() => {}),
			delete: mock(() => {}),
		};

		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const api = makeMockAPI();
		const ctx = makeMockContext();
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("delete nonexistent", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No ferment matching 'nonexistent'.", "warning");
	});

	test("confirms and deletes", async () => {
		clearActive();

		const ferments = [makeTestFerment({ id: "f-del-1", name: "To Delete", status: "running" })];

		const mockStore = {
			listByWorktree: mock(() => ferments),
			save: mock(() => {}),
			delete: mock(() => {}),
		};

		// @ts-expect-error - accessing internals for testing
		FermentStore.open = mock(() => mockStore);

		const confirmMock = mock(async () => true);
		const api = makeMockAPI();
		const ctx = makeMockContext({ ui: makeMockUI({ confirm: confirmMock }) });
		registerFermentCommands(api);

		const handler = (api.registerCommand as any).mock.calls[0][1].handler;
		await handler("delete f-del-1", ctx);

		expect(confirmMock).toHaveBeenCalledWith('Delete ferment "To Delete"?', "This cannot be undone.");
		expect(mockStore.delete).toHaveBeenCalledWith("f-del-1");
		expect(ctx.ui.notify).toHaveBeenCalledWith('Ferment "To Delete" deleted.', "info");
	});
});
