import { beforeAll, describe, expect, it } from "bun:test";
import { Container } from "@aryee337/aery-tui";
import type { Message } from "@aryee337/aery-ai";
import { formatPasteSummary, UserMessageComponent } from "../../../src/modes/components/user-message";
import { initTheme } from "../../../src/modes/theme/theme";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";
import type { InteractiveModeContext } from "../../../src/modes/types";

beforeAll(async () => {
	await initTheme(false);
});

function render(text: string): string {
	return Bun.stripANSI(new UserMessageComponent(text).render(80).join("\n"));
}

describe("UserMessageComponent paste marker rendering", () => {
	it("formats '[paste #1 +50 lines]' into a human-friendly summarized text preview", () => {
		const raw = render("[paste #1 +50 lines]");
		expect(raw).toContain("📋 [Pasted text #1 +50 lines]");
		expect(raw).toContain("You");
	});

	it("formats character-count paste placeholders into summarized text", () => {
		const raw = render("[paste #2 1420 chars]");
		expect(raw).toContain("📋 [Pasted text #2 1420 chars]");
	});

	it("formats AGY-style '[Pasted text #1 +30 lines]' placeholders", () => {
		const raw = render("[Pasted text #1 +30 lines]");
		expect(raw).toContain("📋 [Pasted text #1 +30 lines]");
	});

	it("preserves surrounding user prompt text alongside the summarized paste marker", () => {
		const raw = render("Please analyze this stacktrace:\n[paste #1 +40 lines]\nWhat is the root cause?");
		expect(raw).toContain("Please analyze this stacktrace:");
		expect(raw).toContain("📋 [Pasted text #1 +40 lines]");
		expect(raw).toContain("What is the root cause?");
	});

	it("formats formatPasteSummary helper correctly for diverse markers", () => {
		expect(formatPasteSummary("[paste #1 +12 lines]")).toBe("📋 [Pasted text #1 +12 lines]");
		expect(formatPasteSummary("[paste #5 900 chars]")).toBe("📋 [Pasted text #5 900 chars]");
		expect(formatPasteSummary("[Pasted text: +50 lines]")).toBe("📋 [Pasted text +50 lines]");
		expect(formatPasteSummary("check this: [paste #1 +10 lines]")).toBe("check this: 📋 [Pasted text #1 +10 lines]");
	});
});

describe("UiHelpers paste handling & ghost prevention", () => {
	function createMockContext() {
		const chatContainer = new Container();
		const history: string[] = [];
		const mockEditor = {
			addToHistory: (text: string) => history.push(text),
			setText: () => {},
		};
		const ctx = {
			chatContainer,
			editor: mockEditor,
			getUserMessageText: (msg: Message) => uiHelpers.getUserMessageText(msg),
		} as unknown as InteractiveModeContext;
		const uiHelpers = new UiHelpers(ctx);
		return { ctx, uiHelpers, chatContainer, history };
	}

	it("getUserMessageText preserves paste markers so messages never become ghost empty strings", () => {
		const { uiHelpers } = createMockContext();
		const msg: Message = {
			role: "user",
			content: [{ type: "text", text: "[paste #1 +55 lines]" }],
			timestamp: Date.now(),
		};

		const text = uiHelpers.getUserMessageText(msg);
		expect(text).toBe("[paste #1 +55 lines]");
	});

	it("synthesizes summarized text when visible text is empty but hidden paste payload exists", () => {
		const { uiHelpers } = createMockContext();
		const fullPayload = Array.from({ length: 42 }, (_, i) => `line ${i + 1}`).join("\n");
		const msg: Message = {
			role: "user",
			content: [
				{ type: "text", text: fullPayload, hidden: true } as any,
			],
			timestamp: Date.now(),
		};

		const text = uiHelpers.getUserMessageText(msg);
		expect(text).toBe("[Pasted text: +42 lines]");
	});

	it("addMessageToChat mounts UserMessageComponent for large paste submissions, preventing ghost behavior", () => {
		const { uiHelpers, chatContainer, history } = createMockContext();
		const msg: Message = {
			role: "user",
			content: [
				{ type: "text", text: "[paste #1 +100 lines]" },
				{ type: "text", text: "const x = 1;\n".repeat(100), hidden: true } as any,
			],
			timestamp: Date.now(),
		};

		uiHelpers.addMessageToChat(msg as any, { populateHistory: true });

		expect(chatContainer.children.length).toBe(1);
		const userComp = chatContainer.children[0] as UserMessageComponent;
		expect(userComp).toBeInstanceOf(UserMessageComponent);

		const rendered = Bun.stripANSI(userComp.render(80).join("\n"));
		expect(rendered).toContain("📋 [Pasted text #1 +100 lines]");
		expect(history).toContain("[paste #1 +100 lines]");
	});

	it("addMessageToChat handles hidden-only paste submissions without ghosting", () => {
		const { uiHelpers, chatContainer } = createMockContext();
		const msg: Message = {
			role: "user",
			content: [
				{ type: "text", text: "err 1\nerr 2\nerr 3\nerr 4\nerr 5", hidden: true } as any,
			],
			timestamp: Date.now(),
		};

		uiHelpers.addMessageToChat(msg as any);

		expect(chatContainer.children.length).toBe(1);
		const userComp = chatContainer.children[0] as UserMessageComponent;
		const rendered = Bun.stripANSI(userComp.render(80).join("\n"));
		expect(rendered).toContain("📋 [Pasted text +5 lines]");
	});
});

describe("InputController paste expansion for bash, python, and chat", () => {
	it("expands paste content for bash command submissions (!)", async () => {
		const { InputController } = await import("../../../src/modes/controllers/input-controller");
		let executedCommand = "";
		let isExcludedFlag = false;
		const mockEditor: any = {
			onSubmit: undefined,
			addToHistory: () => {},
			setText: () => {},
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
		};
		const mockCtx: any = {
			editor: mockEditor,
			keybindings: { getKeys: () => [] },
			session: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				messages: [],
				modelRegistry: {},
			},
			settings: { get: () => false },
			pendingImages: [],
			handleBashCommand: async (cmd: string, isExcluded: boolean) => {
				executedCommand = cmd;
				isExcludedFlag = isExcluded;
			},
			updateEditorBorderColor: () => {},
			flushPendingBashComponents: () => {},
			startPendingSubmission: (arg: any) => arg,
		};

		const controller = new InputController(mockCtx);
		controller.setupEditorSubmitHandler();

		expect(mockEditor.onSubmit).toBeDefined();

		// Submit bash command with paste placeholder and hidden expanded payload
		await mockEditor.onSubmit("! [paste #1 +10 lines]", "! echo 'fully expanded paste content'");

		expect(executedCommand).toBe("echo 'fully expanded paste content'");
		expect(isExcludedFlag).toBe(false);
	});

	it("routes normal prompt with paste markers to startPendingSubmission with hiddenPasteText intact", async () => {
		const { InputController } = await import("../../../src/modes/controllers/input-controller");
		let submittedArgs: any = undefined;
		let inputCallbackPayload: any = undefined;

		const mockEditor: any = {
			onSubmit: undefined,
			addToHistory: () => {},
			setText: () => {},
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
		};
		const mockCtx: any = {
			editor: mockEditor,
			keybindings: { getKeys: () => [] },
			session: {
				isStreaming: false,
				isCompacting: false,
				messages: [{ role: "user" }],
				modelRegistry: {},
			},
			settings: { get: () => false },
			pendingImages: [],
			sessionManager: { getSessionName: () => "test-session" },
			flushPendingBashComponents: () => {},
			startPendingSubmission: (input: any) => {
				submittedArgs = input;
				return { ...input, cancelled: false, started: false };
			},
			onInputCallback: (sub: any) => {
				inputCallbackPayload = sub;
			},
		};

		const controller = new InputController(mockCtx);
		controller.setupEditorSubmitHandler();

		await mockEditor.onSubmit("[paste #1 +50 lines]", "const a = 1;\nconst b = 2;\n// 50 lines");

		expect(submittedArgs).toEqual({
			text: "[paste #1 +50 lines]",
			images: undefined,
			hiddenPasteText: "const a = 1;\nconst b = 2;\n// 50 lines",
		});
		expect(inputCallbackPayload.text).toBe("[paste #1 +50 lines]");
		expect(inputCallbackPayload.hiddenPasteText).toBe("const a = 1;\nconst b = 2;\n// 50 lines");
	});
});

