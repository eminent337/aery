import { beforeEach, describe, expect, it, vi } from "bun:test";
import { setKeybindings } from "@aryee337/aery-tui";
import { KeybindingsManager } from "../src/config/keybindings";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";

describe("Selector Escape Guard", () => {
	let ctx: Partial<InteractiveModeContext>;
	let inputListeners: Array<(data: string) => { consume?: boolean } | undefined>;
	let editorOnEscape: (() => void) | undefined;
	let abortSession: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		inputListeners = [];
		editorOnEscape = undefined;
		abortSession = vi.fn();

		const editor = {
			setActionKeys: vi.fn(),
			setText: vi.fn(),
			getText: vi.fn(() => ""),
			addToHistory: vi.fn(),
			setCustomKeyHandler: vi.fn(),
			clearCustomKeyHandlers: vi.fn(),
			get onEscape() {
				return editorOnEscape;
			},
			set onEscape(fn: (() => void) | undefined) {
				editorOnEscape = fn;
			},
		};

		ctx = {
			editor: editor as unknown as InteractiveModeContext["editor"],
			editorContainer: {
				children: [editor as unknown as InteractiveModeContext["editor"]],
			} as unknown as InteractiveModeContext["editorContainer"],
			ui: {
				addInputListener: vi.fn((listener: (data: string) => { consume?: boolean } | undefined) => {
					inputListeners.push(listener);
					return () => {
						const idx = inputListeners.indexOf(listener);
						if (idx !== -1) inputListeners.splice(idx, 1);
					};
				}),
				hasOverlay: vi.fn(() => false),
				requestRender: vi.fn(),
			} as unknown as InteractiveModeContext["ui"],
			keybindings: KeybindingsManager.inMemory(),
			session: {
				isStreaming: true,
				isCompacting: false,
				isRetrying: false,
				hasPostPromptWork: false,
				isBashRunning: false,
				isEvalRunning: false,
				abort: abortSession,
			} as unknown as InteractiveModeContext["session"],
			loadingAnimation: undefined,
			loopModeEnabled: false,
			isBashMode: false,
			isPythonMode: false,
			isSelectorActive: false,
			lastSelectorDismissTime: 0,
			hasActiveBtw: vi.fn(() => false),
			hasActiveOmfg: vi.fn(() => false),
			hasActiveSelector: vi.fn(() => ctx.isSelectorActive ?? false),
			cancelPendingSubmission: vi.fn(() => false),
			lastEscapeTime: 0,
			lastSigintTime: 0,
		};
	});

	it("does not abort session or consume ESC when selector is active and session is busy", () => {
		ctx.isSelectorActive = true;
		const controller = new InputController(ctx as InteractiveModeContext);
		controller.setupKeyHandlers();

		expect(inputListeners.length).toBe(1);
		const listener = inputListeners[0];
		if (!listener) throw new Error("Expected listener to be registered");

		// Send Escape key
		const result = listener("\x1b");

		// Should not consume key (allows selector to handle Escape)
		expect(result).toBeUndefined();
		// Should not call session.abort()
		expect(abortSession).not.toHaveBeenCalled();
	});

	it("suppresses abort in editor.onEscape when selector is active", () => {
		ctx.isSelectorActive = true;
		const controller = new InputController(ctx as InteractiveModeContext);
		controller.setupKeyHandlers();

		// Directly invoke editor.onEscape
		editorOnEscape?.();

		// Should not call session.abort()
		expect(abortSession).not.toHaveBeenCalled();
	});

	it("consumes ESC and suppresses abort during the 400ms grace window after selector dismissal", () => {
		ctx.isSelectorActive = false;
		ctx.lastSelectorDismissTime = Date.now();

		const controller = new InputController(ctx as InteractiveModeContext);
		controller.setupKeyHandlers();

		const listener = inputListeners[0];
		if (!listener) throw new Error("Expected listener to be registered");

		// Send Escape key within grace window
		const result = listener("\x1b");

		// Should consume the key to protect against double-ESC
		expect(result).toEqual({ consume: true });
		// Should not call session.abort()
		expect(abortSession).not.toHaveBeenCalled();

		// Direct editor.onEscape invocation should also be suppressed
		editorOnEscape?.();
		expect(abortSession).not.toHaveBeenCalled();
	});

	it("aborts busy session when no selector is active and grace window has passed", () => {
		ctx.isSelectorActive = false;
		ctx.lastSelectorDismissTime = Date.now() - 1000; // 1 second ago

		const controller = new InputController(ctx as InteractiveModeContext);
		controller.setupKeyHandlers();

		const listener = inputListeners[0];
		if (!listener) throw new Error("Expected listener to be registered");

		// Send Escape key
		const result = listener("\x1b");

		// Should consume the key and abort
		expect(result).toEqual({ consume: true });
		expect(abortSession).toHaveBeenCalledTimes(1);
	});
});
