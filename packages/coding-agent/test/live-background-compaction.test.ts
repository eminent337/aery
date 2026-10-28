import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@aryee337/aery/config/model-registry";
import { Settings } from "@aryee337/aery/config/settings";
import { loadExtensions } from "@aryee337/aery/extensibility/extensions/loader";
import { ExtensionRunner } from "@aryee337/aery/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@aryee337/aery/session/agent-session";
import { AuthStorage } from "@aryee337/aery/session/auth-storage";
import { SessionManager } from "@aryee337/aery/session/session-manager";
import { getBundledModel } from "@aryee337/aery-ai/models";
import { Agent, type AgentMessage } from "@aryee337/aery-core";
import { getProjectAgentDir, TempDir } from "@aryee337/aery-utils";

describe("Live Background Prefix Compaction", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let extensionRunner: ExtensionRunner;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@aery-live-compaction-");
		events = [];

		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-interceptor.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(aery) {",
				'\taery.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "Live background compacted prefix summary",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			extensionRunner,
		});

		session.subscribe(event => {
			events.push(event);
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("executes background compaction without aborting the active agent loop", async () => {
		expect(typeof (AgentSession.prototype as any).compactBackgroundPrefix).toBe("function");

		// Seed initial messages in sessionManager and agent
		const msg1: AgentMessage = { role: "user", content: "first question", timestamp: Date.now() - 3000 };
		const msg2: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "first answer" }],
			timestamp: Date.now() - 2000,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const msg3: AgentMessage = { role: "user", content: "second question", timestamp: Date.now() - 1000 };
		const msg4: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "second answer" }],
			timestamp: Date.now() - 500,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};

		sessionManager.appendMessage(msg1);
		sessionManager.appendMessage(msg2);
		sessionManager.appendMessage(msg3);
		sessionManager.appendMessage(msg4);
		session.agent.replaceMessages([msg1, msg2, msg3, msg4]);

		const abortSpy = vi.spyOn(session, "abort");

		// Trigger live background prefix compaction
		const compactionPromise = (session as any).compactBackgroundPrefix();

		// Simulate the agent generating live messages while compaction is in progress
		const liveMsg: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "active thinking and tool output in progress" }],
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		session.agent.state.messages.push(liveMsg);

		const result = await compactionPromise;

		// 1. Verify compaction result
		expect(result).toBeDefined();
		expect(result.summary).toBe("Live background compacted prefix summary");

		// 2. Verify session.abort was NOT called (non-blocking)
		expect(abortSpy).not.toHaveBeenCalled();

		// 3. Verify messages rebase: compaction summary at beginning, kept messages, and liveMsg preserved
		const currentMessages = session.agent.state.messages;
		expect(currentMessages[0].role).toBe("compactionSummary");
		expect((currentMessages[0] as any).summary).toBe("Live background compacted prefix summary");

		// Live message must still be in agent messages
		const hasLiveMsg = currentMessages.some(
			m => m.role === "assistant" && JSON.stringify(m.content).includes("active thinking"),
		);
		expect(hasLiveMsg).toBe(true);

		// 4. Verify sessionManager contains compaction entry
		const branchEntries = sessionManager.getBranch();
		const hasCompactionEntry = branchEntries.some(e => e.type === "compaction");
		expect(hasCompactionEntry).toBe(true);

		// 5. Verify session_compacted event was emitted
		const compactedEvent = events.find(e => e.type === "session_compacted");
		expect(compactedEvent).toBeDefined();
	});

	it("returns null when session has nothing to compact", async () => {
		// Session is empty
		const result = await session.compactBackgroundPrefix();
		expect(result).toBeNull();
		expect(session.isCompactingInBackground).toBe(false);
	});

	it("reuses the in-flight background promise for concurrent calls", async () => {
		const msg1: AgentMessage = { role: "user", content: "first", timestamp: Date.now() - 2000 };
		const msg2: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			timestamp: Date.now() - 1000,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		sessionManager.appendMessage(msg1);
		sessionManager.appendMessage(msg2);
		session.agent.replaceMessages([msg1, msg2]);

		const promise1 = session.compactBackgroundPrefix();
		expect(session.isCompactingInBackground).toBe(true);
		expect(session.backgroundCompactionPromise).toBe(promise1);

		const promise2 = session.compactBackgroundPrefix();
		expect(promise2).toBe(promise1);

		const [res1, res2] = await Promise.all([promise1, promise2]);
		expect(res1).toBe(res2);
		expect(session.isCompactingInBackground).toBe(false);
		expect(session.backgroundCompactionPromise).toBeNull();
	});

	it("aborts in-flight background compaction when abortCompaction is invoked", async () => {
		const msg1: AgentMessage = { role: "user", content: "first", timestamp: Date.now() - 2000 };
		const msg2: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			timestamp: Date.now() - 1000,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		sessionManager.appendMessage(msg1);
		sessionManager.appendMessage(msg2);
		session.agent.replaceMessages([msg1, msg2]);

		const promise = session.compactBackgroundPrefix();
		session.abortCompaction();

		const result = await promise;
		expect(result).toBeNull();
		expect(session.isCompactingInBackground).toBe(false);
	});

	it("triggers compactBackgroundPrefix during threshold check when background compaction is preferred", async () => {
		(session.settings as any).override("compaction.background", true);

		const msg1: AgentMessage = { role: "user", content: "first", timestamp: Date.now() - 2000 };
		const msg2: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			timestamp: Date.now() - 1000,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		sessionManager.appendMessage(msg1);
		sessionManager.appendMessage(msg2);
		session.agent.replaceMessages([msg1, msg2]);

		const backgroundCompactSpy = vi.spyOn(session, "compactBackgroundPrefix");
		const abortSpy = vi.spyOn(session, "abort");

		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg2] });

		// Allow microtasks to run
		await new Promise(resolve => setTimeout(resolve, 50));

		expect(backgroundCompactSpy).toHaveBeenCalled();
		expect(abortSpy).not.toHaveBeenCalled();
	});
});
