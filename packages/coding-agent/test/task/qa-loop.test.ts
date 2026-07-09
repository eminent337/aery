import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { runSubprocessWithQa } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";
import * as git from "../../src/utils/git";

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
	}) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let promptIndex = 0;
	const state = { messages: [] as unknown[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ text, options, promptIndex, emit });
		},
		sendCustomMessage: vi.fn(async () => {}),
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as import("../../src/extensibility/extensions/types").LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Two-Stage QA Review Loops", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const implementerAgent: AgentDefinition = {
		name: "task",
		description: "implementer",
		systemPrompt: "implementer",
		source: "bundled",
	};

	const specReviewerAgent: AgentDefinition = {
		name: "spec-reviewer",
		description: "spec reviewer",
		systemPrompt: "spec reviewer",
		source: "bundled",
		output: {
			properties: {
				overall_correctness: { type: "string" },
				explanation: { type: "string" },
			},
		},
	};

	const codeReviewerAgent: AgentDefinition = {
		name: "reviewer",
		description: "code reviewer",
		systemPrompt: "code reviewer",
		source: "bundled",
		output: {
			properties: {
				overall_correctness: { type: "string" },
				explanation: { type: "string" },
			},
		},
	};

	const agentsCatalog = [implementerAgent, specReviewerAgent, codeReviewerAgent];

	const baseOptions = {
		cwd: "/tmp",
		agent: implementerAgent,
		task: "Implement feature X",
		assignment: "Implement feature X",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("passes both spec compliance and code quality loops on success", async () => {
		// Mock git.diff.has to return true to simulate code-modifying task
		vi.spyOn(git.diff, "has").mockResolvedValue(true);

		let runsCount = 0;
		const mockSession = createMockSession(({ text, emit }) => {
			runsCount++;
			// Determine which agent is executing by matching options / prompt text
			if (text.includes("Review this diff against the task")) {
				// spec-reviewer
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-spec",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Spec is compliant" }],
						details: { status: "success", data: { overall_correctness: "correct", explanation: "All good" } },
					},
					isError: false,
				});
			} else if (text.includes("Review the quality of this diff")) {
				// code reviewer
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-quality",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Quality is good" }],
						details: { status: "success", data: { overall_correctness: "correct", explanation: "Code looks solid" } },
					},
					isError: false,
				});
			} else {
				// implementer
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-impl",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Implementation done" }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(mockSession));

		const result = await runSubprocessWithQa(baseOptions, agentsCatalog, "Implement feature X");

		expect(result.exitCode).toBe(0);
		expect(runsCount).toBe(3); // 1 implementer run + 1 spec review + 1 quality review
	});

	it("re-runs implementer when spec compliance fails and succeeds on retry", async () => {
		vi.spyOn(git.diff, "has").mockResolvedValue(true);

		let specReviewCount = 0;
		let runsCount = 0;
		const mockSession = createMockSession(({ text, emit }) => {
			runsCount++;
			if (text.includes("Review this diff against the task")) {
				specReviewCount++;
				const overall_correctness = specReviewCount === 1 ? "incorrect" : "correct";
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-spec",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: `Spec status: ${overall_correctness}` }],
						details: { status: "success", data: { overall_correctness, explanation: "Missing feature Y" } },
					},
					isError: false,
				});
			} else if (text.includes("Review the quality of this diff")) {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-quality",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Quality ok" }],
						details: { status: "success", data: { overall_correctness: "correct", explanation: "OK" } },
					},
					isError: false,
				});
			} else {
				// implementer
				// On second run, assignment should contain feedback
				if (runsCount > 1) {
					expect(text).toContain("SPEC COMPLIANCE FEEDBACK");
				}
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-impl",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Implementation done" }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(mockSession));

		const result = await runSubprocessWithQa(baseOptions, agentsCatalog, "Implement feature X");

		expect(result.exitCode).toBe(0);
		// Runs: Impl1 (fail spec) -> Spec1 -> Impl2 (pass spec) -> Spec2 -> Quality1
		expect(runsCount).toBe(5);
	});
});
