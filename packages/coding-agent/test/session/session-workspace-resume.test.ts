import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getWorkspaceRoot, isSameWorkspace, SessionIndexStore } from "../../src/session/session-index";
import { resolveResumableSession, SessionManager } from "../../src/session/session-manager";

describe("AGY-Style Workspace Session Resumption & Indexing", () => {
	let tempRootDir: string;
	let gitProjectDir: string;
	let subDir: string;
	let separateProjectDir: string;
	let dbPath: string;

	beforeEach(() => {
		tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "aery-ws-test-"));
		gitProjectDir = path.join(tempRootDir, "repo-root");
		subDir = path.join(gitProjectDir, "packages", "sub-package");
		separateProjectDir = path.join(tempRootDir, "other-project");

		fs.mkdirSync(subDir, { recursive: true });
		fs.mkdirSync(separateProjectDir, { recursive: true });

		// Simulate git repository at gitProjectDir
		fs.mkdirSync(path.join(gitProjectDir, ".git"), { recursive: true });

		dbPath = path.join(tempRootDir, "test_session_index.db");
	});

	afterEach(() => {
		try {
			SessionIndexStore.closeAll();
		} catch {}
		if (fs.existsSync(tempRootDir)) {
			fs.rmSync(tempRootDir, { recursive: true, force: true });
		}
	});

	describe("Workspace Resolution", () => {
		it("resolves git root as workspace root for subdirectories", () => {
			const root = getWorkspaceRoot(subDir);
			expect(fs.realpathSync(root)).toBe(fs.realpathSync(gitProjectDir));
		});

		it("identifies directories within the same git repo as the same workspace", () => {
			expect(isSameWorkspace(gitProjectDir, subDir)).toBe(true);
			expect(isSameWorkspace(subDir, gitProjectDir)).toBe(true);
		});

		it("identifies unrelated directories as different workspaces", () => {
			expect(isSameWorkspace(gitProjectDir, separateProjectDir)).toBe(false);
		});
	});

	describe("SessionIndexStore", () => {
		it("records and retrieves sessions for workspace", () => {
			const store = SessionIndexStore.open(dbPath);
			const sessionFile = path.join(gitProjectDir, "session1.jsonl");
			fs.writeFileSync(sessionFile, "dummy");

			store.upsertSession({
				sessionId: "sess-1",
				filePath: sessionFile,
				cwd: gitProjectDir,
				canonicalCwd: fs.realpathSync(gitProjectDir),
				workspaceRoot: fs.realpathSync(gitProjectDir),
				title: "My Feature Session",
				messageCount: 5,
				createdAt: 1000,
				updatedAt: 2000,
				firstPrompt: "Implement feature X",
			});

			const recent = store.getMostRecentForWorkspace(subDir);
			expect(recent).not.toBeNull();
			expect(recent?.sessionId).toBe("sess-1");
			expect(recent?.title).toBe("My Feature Session");
		});

		it("prioritizes sessions with messages over empty 0-message sessions", () => {
			const store = SessionIndexStore.open(dbPath);
			const sessionFile1 = path.join(gitProjectDir, "session1.jsonl");
			const sessionFile2 = path.join(subDir, "session2.jsonl");
			fs.writeFileSync(sessionFile1, "dummy1");
			fs.writeFileSync(sessionFile2, "dummy2");

			// Real session created earlier
			store.upsertSession({
				sessionId: "sess-real",
				filePath: sessionFile1,
				cwd: gitProjectDir,
				canonicalCwd: fs.realpathSync(gitProjectDir),
				workspaceRoot: fs.realpathSync(gitProjectDir),
				title: "Active Work",
				messageCount: 10,
				createdAt: 1000,
				updatedAt: 2000,
			});

			// Empty/aborted session created later in subDir
			store.upsertSession({
				sessionId: "sess-empty",
				filePath: sessionFile2,
				cwd: subDir,
				canonicalCwd: fs.realpathSync(subDir),
				workspaceRoot: fs.realpathSync(gitProjectDir),
				title: undefined,
				messageCount: 0,
				createdAt: 3000,
				updatedAt: 3000,
			});

			const recent = store.getMostRecentForWorkspace(subDir);
			expect(recent).not.toBeNull();
			// Must select the real session, NOT the empty session!
			expect(recent?.sessionId).toBe("sess-real");
		});

		it("lists all sessions belonging to the workspace", () => {
			const store = SessionIndexStore.open(dbPath);
			const file1 = path.join(gitProjectDir, "s1.jsonl");
			const file2 = path.join(subDir, "s2.jsonl");
			const file3 = path.join(separateProjectDir, "s3.jsonl");
			fs.writeFileSync(file1, "1");
			fs.writeFileSync(file2, "2");
			fs.writeFileSync(file3, "3");

			store.upsertSession({
				sessionId: "s1",
				filePath: file1,
				cwd: gitProjectDir,
				canonicalCwd: fs.realpathSync(gitProjectDir),
				workspaceRoot: fs.realpathSync(gitProjectDir),
				messageCount: 2,
				createdAt: 100,
				updatedAt: 200,
			});
			store.upsertSession({
				sessionId: "s2",
				filePath: file2,
				cwd: subDir,
				canonicalCwd: fs.realpathSync(subDir),
				workspaceRoot: fs.realpathSync(gitProjectDir),
				messageCount: 3,
				createdAt: 150,
				updatedAt: 300,
			});
			store.upsertSession({
				sessionId: "s3",
				filePath: file3,
				cwd: separateProjectDir,
				canonicalCwd: fs.realpathSync(separateProjectDir),
				workspaceRoot: fs.realpathSync(separateProjectDir),
				messageCount: 1,
				createdAt: 50,
				updatedAt: 50,
			});

			const listFromSub = store.listForWorkspace(subDir);
			expect(listFromSub.length).toBe(2);
			const ids = listFromSub.map(s => s.sessionId);
			expect(ids).toContain("s1");
			expect(ids).toContain("s2");
			expect(ids).not.toContain("s3");
		});

		it("syncFromDisk imports pre-existing session files from disk into SQLite index", async () => {
			const fakeSessionsRoot = path.join(tempRootDir, "all_sessions");
			const projectSessionDir = path.join(fakeSessionsRoot, "-my-custom-project");
			fs.mkdirSync(projectSessionDir, { recursive: true });

			const existingFile = path.join(projectSessionDir, "2026-10-25T10-00-00-000Z_sess-historical.jsonl");
			const content = [
				JSON.stringify({
					type: "session",
					id: "sess-historical",
					cwd: gitProjectDir,
					title: "Historical Session",
					timestamp: "2026-10-25T10:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "Historical task" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "Historical answer" } }),
			].join("\n");
			fs.writeFileSync(existingFile, content);

			const store = SessionIndexStore.open(dbPath);
			await store.syncFromDisk(fakeSessionsRoot);

			const recent = store.getMostRecentForWorkspace(subDir);
			expect(recent).not.toBeNull();
			expect(recent?.sessionId).toBe("sess-historical");
			expect(recent?.title).toBe("Historical Session");
			expect(recent?.messageCount).toBe(2);
		});
	});

	describe("End-to-End Workspace Resumption with SessionManager", () => {
		it("continues recent session across subdirectories using default session directories", async () => {
			// Create session in gitProjectDir using default session dir
			const sm1 = SessionManager.create(gitProjectDir);
			await sm1.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Root session without explicit dir" }],
				timestamp: Date.now(),
			});
			await sm1.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Response in root" }],
				api: "openai-completions",
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await sm1.flush();
			const rootSessionFile = sm1.getSessionFile()!;
			expect(rootSessionFile).toBeDefined();

			// Now continue recent from subDir (with default sessionDir)
			const smResumed = await SessionManager.continueRecent(subDir);
			expect(smResumed.getSessionFile()).toBe(rootSessionFile);
			expect(smResumed.getEntries().length).toBeGreaterThan(1);
		});

		it("lists workspace sessions from a subdirectory", async () => {
			const sm1 = SessionManager.create(gitProjectDir);
			await sm1.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Root workspace task" }],
				timestamp: Date.now(),
			});
			await sm1.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Root workspace answer" }],
				api: "openai-completions",
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await sm1.flush();

			const list = await SessionManager.list(subDir);
			expect(list.length).toBeGreaterThan(0);
			const found = list.find(s => s.id === sm1.getSessionId());
			expect(found).toBeDefined();
		});

		it("resolves resumable session with local scope when invoked from subdirectory with default dirs", async () => {
			const sm = SessionManager.create(gitProjectDir);
			await sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Work in repo" }],
				timestamp: Date.now(),
			});
			await sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Reply" }],
				api: "openai-completions",
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await sm.flush();
			const sessionId = sm.getSessionId();

			// Resolve from subDir
			const match = await resolveResumableSession(sessionId, subDir);
			expect(match).toBeDefined();
			// Crucial: Must be "local" so main.ts does not demand a fork!
			expect(match?.scope).toBe("local");
		});
	});
});
