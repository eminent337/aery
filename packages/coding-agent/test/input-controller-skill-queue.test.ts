/**
 * Phase 6 — E layer.
 *
 * Tests the skill-queue + queue-chip contract (omp-style live-derived display):
 *   - InputController.#invokeSkillCommand stamps details.__queueChipText when
 *     streaming (no separate display twin — chips derive from the agent queue);
 *   - AgentSession.getQueuedMessages/queuedMessageCount read the agent's live
 *     queues via peek APIs (single source of truth);
 *   - UiHelpers.updatePendingMessagesDisplay renders compact slash-form chips;
 *   - InputController.restoreQueuedMessagesToEditor clears the agent queue;
 *   - EventController custom-role message_start refreshes the pending bar when
 *     details.__queueChipText is present.
 *
 * Tests split into:
 *   - E1-E3: InputController-side chip stamping, stubbed session;
 *   - E4-E7: Real AgentSession queue lifecycle via steer/followUp/pop/clear;
 *   - E8: real UiHelpers render against a queued custom message;
 *   - E9: real InputController.restoreQueuedMessagesToEditor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@aryee337/aery/config/model-registry";
import { Settings } from "@aryee337/aery/config/settings";
import { EventController } from "@aryee337/aery/modes/controllers/event-controller";
import { InputController } from "@aryee337/aery/modes/controllers/input-controller";
import { getThemeByName, setThemeInstance } from "@aryee337/aery/modes/theme/theme";
import type { InteractiveModeContext } from "@aryee337/aery/modes/types";
import { UiHelpers } from "@aryee337/aery/modes/utils/ui-helpers";
import { AgentSession, type AgentSessionEvent } from "@aryee337/aery/session/agent-session";
import { AuthStorage } from "@aryee337/aery/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@aryee337/aery/session/messages";
import { SessionManager } from "@aryee337/aery/session/session-manager";
import { getBundledModel } from "@aryee337/aery-ai/models";
import { Agent } from "@aryee337/aery-core";
import { Container } from "@aryee337/aery-tui";
import { TempDir } from "@aryee337/aery-utils";

// ============================================================================
// Shared helpers
// ============================================================================

function writeSkillFile(dir: string, skillName: string, body: string): string {
	const skillPath = path.join(dir, `${skillName}.md`);
	fs.writeFileSync(skillPath, `---\nname: ${skillName}\n---\n${body}\n`);
	return skillPath;
}

// ============================================================================
// E1-E3: InputController tag generation with a stubbed session.
// ============================================================================

type StubEditor = {
	setText: (text: string) => void;
	getText: () => string;
	addToHistory: ReturnType<typeof vi.fn>;
	onSubmit?: (text: string) => Promise<void>;
};

function createStubInputControllerContext(opts: { skillCommands: Map<string, string>; isStreaming: boolean }) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	// Chips are stamped via details.__queueChipText; no enqueue mock needed.
	// Annotate parameters so `mock.calls[N]` is typed as a tuple (not `[]`) and
	// `message` carries required skill prompt details for assertion below.
	const promptCustomMessage = vi.fn(async (_message: { details: SkillPromptDetails }, _options?: unknown) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: opts.skillCommands,
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			// Chips derive from the live agent queue; no enqueue mock on the stub.
			promptCustomMessage,
		},
		showError,
		updatePendingMessagesDisplay,
		// Defaults that InputController touches on submit but don't matter here.
		isBashMode: false,
		isPythonMode: false,
		pendingImages: [],
		isBackgrounded: false,
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, promptCustomMessage };
}

describe.skip("InputController #invokeSkillCommand (E1-E3)", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, string>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@aery-skill-queue-stub-");
		const skillPath = writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, string>([["skill:test-skill", skillPath]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("E1: streaming + steer -> details.__queueChipText stamped with the compact slash form", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.details.__queueChipText).toBe("/skill:test-skill arg1 arg2");
	});

	it("E2: streaming + followUp -> details.__queueChipText stamped on the Ctrl+Enter path", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});

		const controller = new InputController(ctx);
		editor.setText("/skill:test-skill arg1 arg2");
		// `handleFollowUp` is the Ctrl+Enter dispatcher; it routes through the same
		// `#invokeSkillCommand` helper with mode "followUp".
		await controller.handleFollowUp();

		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.details.__queueChipText).toBe("/skill:test-skill arg1 arg2");
	});

	it("E3: not streaming -> no chip stamped", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.details.__queueChipText).toBeUndefined();
	});
});

// ============================================================================
// E4-E7: Real AgentSession driving synthetic `message_start` events.
// ============================================================================

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@aery-skill-queue-real-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
	});

	return { tempDir, authStorage, session };
}

/** Build a queued skill custom message (the shape the skill path dispatches). */
function skillCustomMessage(content: string, chipText?: string): Extract<
	Parameters<AgentSession["promptCustomMessage"]>[0],
	{ customType: string }
> {
	return {
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content,
		display: true,
		details: chipText === undefined ? undefined : { __queueChipText: chipText },
		attribution: "user",
	};
}

/** Queue a skill custom message directly on the agent queue (as the loop sees it). */
function queueSkillCustom(
	session: AgentSession,
	content: string,
	chipText: string | undefined,
	mode: "steer" | "followUp",
): void {
	const message = skillCustomMessage(content, chipText);
	const queued = {
		role: "custom",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: message.details,
		attribution: "user",
		timestamp: Date.now(),
	};
	if (mode === "followUp") {
		session.agent.followUp(queued as never);
	} else {
		session.agent.steer(queued as never);
	}
}

describe("AgentSession live queue (E4-E7)", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("E4: queued custom chip text appears in getQueuedMessages and survives until drained", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueSkillCustom(session, "irrelevant content", "/skill:foo bar", "steer");
		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);
		expect(session.queuedMessageCount).toBe(1);
		// Simulate the loop draining the queue: once the entry is gone from the
		// agent queue, the chip derives empty from the live queue — no mirror to
		// desync. getQueuedMessages reads the same state the loop drains.
		session.agent.replaceQueues([], []);
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("E5: queued custom without __queueChipText falls back to its content text", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueSkillCustom(session, "plain content", undefined, "steer");
		expect(session.getQueuedMessages().steering).toEqual(["plain content"]);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("E6: queued follow-up custom chip lands in the followUp list", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueSkillCustom(session, "irrelevant content", "/skill:bar baz", "followUp");
		expect(session.getQueuedMessages().followUp).toEqual(["/skill:bar baz"]);
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("E7: popLastQueuedMessage removes the underlying agent-queue entry", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueSkillCustom(session, "irrelevant content", "/skill:foo bar", "steer");
		const popped = session.popLastQueuedMessage();
		expect(popped).toBe("/skill:foo bar");
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.popLastQueuedMessage()).toBeUndefined();
	});
});

// ============================================================================
// E8-E9: Real UiHelpers / InputController against the live agent queue.
// ============================================================================

function createStubInteractiveModeContextForUiHelpers(session: AgentSession) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const pendingMessagesContainer = new Container();
	const requestRender = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		pendingMessagesContainer,
		session,
		compactionQueuedMessages: [],
		keybindings: {
			getDisplayString: (_action: string) => "Alt+Up",
		},
		updatePendingMessagesDisplay,
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, pendingMessagesContainer };
}

describe("UiHelpers / InputController against the queued-display layer (E8-E9)", () => {
	let fixture: SessionFixture | undefined;

	beforeEach(async () => {
		// E8 invokes the real `theme.fg(...)` codepath inside
		// updatePendingMessagesDisplay; without an initialized theme module the
		// global `theme` variable is undefined. Installs `dark` per-test —
		// matches the established suite convention used by other test files
		// (bash-execution-clamp.test.ts, bash-execution-sixel.test.ts) where
		// `dark` is the agreed default for every test that needs a theme.
		// No `afterEach` restore is required by that convention; the theme
		// module exposes no reset API, and `dark` is the suite-wide assumed
		// post-state.
		const themeInstance = await getThemeByName("dark");
		expect(themeInstance).toBeDefined();
		setThemeInstance(themeInstance!);
	});

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("E8: updatePendingMessagesDisplay renders the compact slash form for queued skills", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueSkillCustom(session, "irrelevant content", "/skill:test-skill arg1 arg2", "steer");

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		// Render the container at a generous width and assert the compact slash-form
		// chip appears verbatim. Matches the user-facing "Steer: /skill:..." format.
		const rendered = pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toMatch(/Steer: \/skill:test-skill arg1 arg2/);
	});

	it("E9: restoreQueuedMessagesToEditor recovers the compact slash form into the editor and clears the queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueSkillCustom(session, "irrelevant content", "/skill:test-skill arg1 arg2", "steer");

		const { ctx, editor } = createStubInteractiveModeContextForUiHelpers(session);
		const controller = new InputController(ctx);
		const count = controller.restoreQueuedMessagesToEditor();
		expect(count).toBe(1);
		expect(editor.getText()).toBe("/skill:test-skill arg1 arg2");
		// Underlying agent queue cleared.
		const { steering, followUp } = session.getQueuedMessages();
		expect(steering).toEqual([]);
		expect(followUp).toEqual([]);
	});

});

// ============================================================================
// E10: EventController refreshes the pending-messages bar on queued custom
// dequeue.
//
// Regression guard: the custom-role `message_start` branch in
// EventController.#handleMessageStart must call updatePendingMessagesDisplay
// when the dequeued custom message carries details.__queueChipText (proof it
// was queued via the skill path and shown as a pending chip). Covers both gate
// branches:
//   - positive: chip-tagged custom -> refresh fires once
//   - negative: untagged custom (ttsr-injection, irc:*, async-result, hookMessage)
//     -> refresh NOT fired (over-refresh guard)
// ============================================================================
function createEventControllerFixtureForE10() {
	const updatePendingMessagesDisplay = vi.fn();
	const addMessageToChat = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender, setEagerNativeScrollbackRebuild: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		addMessageToChat,
		updatePendingMessagesDisplay,
		pendingTools: new Map(),
		session: {},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, updatePendingMessagesDisplay, addMessageToChat };
}

describe("EventController custom-role dequeue refresh (E10)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("E10: message_start with role=custom refreshes pending bar ONLY when __queueChipText is present", async () => {
		const { controller, updatePendingMessagesDisplay, addMessageToChat } = createEventControllerFixtureForE10();

		// Positive case: chip-stamped custom => refresh fires exactly once. The chip
		// is the unambiguous signal "this message was queued via the skill path";
		// the rebuild repaints the now-correct queue state derived from the live
		// agent queue.
		const taggedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "first",
				display: true,
				details: {
					__queueChipText: "/skill:foo bar",
					name: "foo",
					path: "/s.md",
					args: "bar",
					lineCount: 1,
				} satisfies SkillPromptDetails,
				timestamp: Date.now(),
			},
		};
		await controller.handleEvent(taggedEvent);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Chat rendering still ran — refresh is additive, not a replacement for the
		// chat path.
		expect(addMessageToChat).toHaveBeenCalledTimes(1);

		// Negative case: untagged custom => refresh NOT fired. Over-refresh guard.
		// Non-queued customs (ttsr-injection, irc:*, async-result, hookMessage) never
		// registered a pending chip, so rebuilding pendingMessagesContainer for them
		// would be pure waste. Distinct timestamp avoids the #renderedCustomMessages
		// signature-dedup early-return.
		const untaggedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "second",
				display: true,
				details: undefined,
				timestamp: Date.now() + 1,
			},
		};
		await controller.handleEvent(untaggedEvent);
		// Still exactly 1 — no additional call from the untagged path.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Chat rendering still ran for the untagged custom (the chat-add path is
		// unconditional inside the custom branch; only the pending-bar refresh is
		// tag-gated).
		expect(addMessageToChat).toHaveBeenCalledTimes(2);
	});
});
