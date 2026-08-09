import { describe, expect, it, mock } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { TanCommandController } from "../src/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../src/session/messages";

describe("TanCommandController", () => {
	it("registers the background job and sends the custom dispatch notice", async () => {
		const showStatusMock = mock(() => {});
		const showErrorMock = mock(() => {});
		const rebuildChatMock = mock(() => {});
		const sendCustomMessageMock = mock(() => Promise.resolve());
		const getSessionFileMock = mock(() => "/tmp/session.jsonl");

		const mockSession = {
			model: { provider: "openai", id: "gpt-4o" },
			sessionId: "parent-session-id",
			configuredThinkingLevel: () => "high",
			systemPrompt: ["system"],
			getActiveToolNames: () => ["read", "write"],
			modelRegistry: {
				authStorage: {},
			},
			getAgentId: () => "Main",
			isStreaming: false,
			sendCustomMessage: sendCustomMessageMock,
		};

		const mockCtx: Partial<InteractiveModeContext> = {
			showStatus: showStatusMock,
			showError: showErrorMock,
			rebuildChatFromMessages: rebuildChatMock,
			session: mockSession as any,
			sessionManager: {
				getSessionFile: getSessionFileMock,
				ensureOnDisk: mock(() => Promise.resolve()),
				flush: mock(() => Promise.resolve()),
				getCwd: mock(() => "/tmp"),
			} as any,
			settings: {
				get: mock((key: string) => {
					if (key === "task.enableLsp") return true;
					return undefined;
				}),
				getGroup: mock(() => ({})),
				getStorage: mock(() => null),
			} as any,
		};

		const mockJobManager = {
			register: mock((type, label, run, opts) => {
				return "job-123";
			}),
		};
		AsyncJobManager.setInstance(mockJobManager as any);

		try {
			const controller = new TanCommandController(mockCtx as InteractiveModeContext);
			await controller.start("test tangential work");

			expect(showStatusMock).toHaveBeenCalledWith("Dispatched background tan job-123");
			expect(sendCustomMessageMock).toHaveBeenCalled();
			const sentMsg = (sendCustomMessageMock.mock.calls as any)[0][0];
			expect(sentMsg.customType).toBe(BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE);
			expect(sentMsg.details.jobId).toBe("job-123");
			expect(sentMsg.details.work).toBe("test tangential work");
		} finally {
			AsyncJobManager.setInstance(undefined);
		}
	});
});
