import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@aryee337/aery-ai/models";
import { sanitizeMemoryContent } from "../../src/hindsight/content";
import { extractMessages } from "../../src/hindsight/transcript";
import { loadEntriesFromFile, SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";

class CountingMemorySessionStorage extends MemorySessionStorage {
	writeTextSyncCalls = 0;

	writeTextSync(filePath: string, content: string): void {
		this.writeTextSyncCalls++;
		super.writeTextSync(filePath, content);
	}
}

function makeAssistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

describe("large session memory guards", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	it("does not rewrite an already-current session during sync flush", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		// Await any pending async writes to complete first.
		await session.flush();

		storage.writeTextSyncCalls = 0;
		session.flushSync();

		expect(storage.writeTextSyncCalls).toBe(0);
	});

	it("elides superseded compactions and rewrites the compacted file", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		const firstSummary = `first-${"x".repeat(4096)}`;
		const secondSummary = `second-${"y".repeat(4096)}`;
		session.appendCompaction(firstSummary, undefined, firstKeptEntryId, 1000, undefined, undefined, {
			openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] },
		});
		session.appendCompaction(secondSummary, undefined, firstKeptEntryId, 1000);
		await session.flush();

		const compactions = session.getEntries().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).not.toBe(firstSummary);
		expect(compactions[0]?.summary).toContain("Superseded compaction");
		expect(compactions[0]?.preserveData).toBeUndefined();
		expect(compactions[1]?.summary).toBe(secondSummary);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const persisted = await storage.readText(sessionFile);
		expect(persisted).not.toContain(firstSummary);
		expect(persisted).toContain(secondSummary);
	});

	it("streams large session files and keeps only the latest compaction summary", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aery-large-session-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "large.jsonl");
		const oldSummary = `old-${"x".repeat(5 * 1024 * 1024)}`;
		const latestSummary = `latest-${"y".repeat(5 * 1024 * 1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: oldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "c1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: makeAssistantMessage("hello"),
			},
			{
				type: "compaction",
				id: "c2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: latestSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const compactions = entries.filter(entry => entry.type === "compaction");

		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).not.toBe(oldSummary);
		expect(compactions[0]?.summary).toContain("Superseded compaction");
		expect(compactions[0]?.preserveData).toBeUndefined();
		expect(compactions[1]?.summary).toBe(latestSummary);
	});

	it("preserves sibling-branch compactions when a newer compaction lands on another branch", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const rootId = session.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("root reply"));

		const branchACompactionSummary = `branch-a-${"x".repeat(1024)}`;
		const branchAPreserve = { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } };
		session.appendCompaction(
			branchACompactionSummary,
			undefined,
			rootId,
			1000,
			undefined,
			undefined,
			branchAPreserve,
		);
		const branchACompactionId = session.getLeafId();
		if (!branchACompactionId) throw new Error("Expected branch A compaction id");

		session.branch(rootId);
		session.appendMessage(makeAssistantMessage("branch B reply"));
		const branchBCompactionSummary = `branch-b-${"y".repeat(1024)}`;
		session.appendCompaction(branchBCompactionSummary, undefined, rootId, 1000);

		const branchACompaction = session.getEntry(branchACompactionId);
		if (branchACompaction?.type !== "compaction") throw new Error("Expected sibling compaction entry");
		expect(branchACompaction.summary).toBe(branchACompactionSummary);
		expect(branchACompaction.preserveData).toEqual(branchAPreserve);

		const branchBCompactions = session
			.getEntries()
			.filter(entry => entry.type === "compaction" && entry.summary === branchBCompactionSummary);
		expect(branchBCompactions).toHaveLength(1);
	});

	it("only elides loaded compactions on the active branch", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aery-branch-load-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "branched.jsonl");
		const branchASummary = `branch-a-${"x".repeat(1024)}`;
		const branchBOldSummary = `branch-b-old-${"y".repeat(1024)}`;
		const branchBNewSummary = `branch-b-new-${"z".repeat(1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "shared", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "ca",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: branchASummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } },
			},
			{
				type: "compaction",
				id: "cb1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: branchBOldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "cb1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: makeAssistantMessage("branch b reply"),
			},
			{
				type: "compaction",
				id: "cb2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: branchBNewSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const byId = new Map(entries.map(entry => [(entry as { id?: string }).id, entry] as const));
		const branchA = byId.get("ca");
		const branchBOld = byId.get("cb1");
		const branchBNew = byId.get("cb2");
		if (branchA?.type !== "compaction" || branchBOld?.type !== "compaction" || branchBNew?.type !== "compaction") {
			throw new Error("Expected compaction entries");
		}

		expect(branchA.summary).toBe(branchASummary);
		expect(branchA.preserveData).toBeDefined();
		expect(branchBOld.summary).toContain("Superseded compaction");
		expect(branchBOld.preserveData).toBeUndefined();
		expect(branchBNew.summary).toBe(branchBNewSummary);
	});

	it("uses developer prefix text when a fork has no early user message", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const sessionFile = `${sessionDir}/fork.jsonl`;
		const lines = [
			{ type: "session", version: 3, id: "fork", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
			{
				type: "message",
				id: "d1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "developer", content: "Plan fork context", timestamp: 1 },
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		storage.writeTextSync(sessionFile, lines.join(""));

		const sessions = await SessionManager.list("/work", sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toBe("Plan fork context");
	});

	it("elides historical tool result screenshot images on load while keeping recent ones", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aery-tool-elision-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "session-with-shots.jsonl");

		const bigBase64_1 = "A".repeat(500);
		const bigBase64_2 = "B".repeat(500);
		const bigBase64_3 = "C".repeat(500);

		const lines = [
			{ type: "session", version: 3, id: "sess-shots", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "desktop_control",
					content: [{ type: "text", text: "Screenshot captured" }],
					details: { action: "screenshot", base64: bigBase64_1 },
				},
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "desktop_control",
					content: [{ type: "text", text: "Screenshot 2 captured" }],
					details: { action: "screenshot", base64: bigBase64_2 },
				},
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-3",
					toolName: "desktop_control",
					content: [{ type: "text", text: "Screenshot 3 captured" }],
					details: { action: "screenshot", base64: bigBase64_3 },
				},
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		expect(entries).toHaveLength(4);

		const m1 = (entries[1] as any).message;
		const m2 = (entries[2] as any).message;
		const m3 = (entries[3] as any).message;

		// The oldest one (m1) should be elided
		expect(m1.details.base64).toBe("[historical screenshot omitted]");
		// The 2 most recent ones (m2 and m3) should be preserved
		expect(m2.details.base64).toBe(bigBase64_2);
		expect(m3.details.base64).toBe(bigBase64_3);
	});

	it("sanitizes memory content and strips large base64 image blobs", () => {
		const rawText = "User asked for help with a screenshot: data:image/png;base64," + "X".repeat(200);
		const sanitized = sanitizeMemoryContent(rawText);
		expect(sanitized).toBe("User asked for help with a screenshot: [image omitted]");

		const jsonDump = '{"status": "ok", "base64": "' + "Y".repeat(200) + '"}';
		const sanitizedJson = sanitizeMemoryContent(jsonDump);
		expect(sanitizedJson).toBe('{"status": "ok", "base64": "[image omitted]"}');
	});

	it("extracts only requested recent turns with reverse scanning", () => {
		const fakeSessionManager = {
			getEntries: () => [
				{ type: "message", message: { role: "user", content: "turn 1" } },
				{ type: "message", message: makeAssistantMessage("reply 1") },
				{ type: "message", message: { role: "user", content: "turn 2" } },
				{ type: "message", message: makeAssistantMessage("reply 2") },
				{ type: "message", message: { role: "user", content: "turn 3" } },
				{ type: "message", message: makeAssistantMessage("reply 3") },
			],
		};

		// Request only the last 2 turns
		const extracted = extractMessages(fakeSessionManager as any, 2);
		expect(extracted).toHaveLength(4);
		expect(extracted[0]?.content).toBe("turn 2");
		expect(extracted[1]?.content).toBe("reply 2");
		expect(extracted[2]?.content).toBe("turn 3");
		expect(extracted[3]?.content).toBe("reply 3");
	});
});
