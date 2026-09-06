import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";
import { ForkSessionTool } from "../src/tools/ai-autonomous-tools";
import type { ToolSession } from "../src/tools";
import { resolveToCwd } from "../src/tools/path-utils";

describe("Cross-directory session forking", () => {
	let rootTempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		rootTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aery-fork-test-"));
		projectA = path.join(rootTempDir, "project-a");
		projectB = path.join(rootTempDir, "project-b");
		fs.mkdirSync(projectA, { recursive: true });
		fs.mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(rootTempDir)) {
			fs.rmSync(rootTempDir, { recursive: true, force: true });
		}
	});
	it("forks a session into a different target directory cleanly", async () => {
		const sessionManagerA = SessionManager.create(projectA);
		await sessionManagerA.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Hello from Project A" }],
			timestamp: Date.now(),
		});
		await sessionManagerA.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Response from Project A" }],
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
		await sessionManagerA.flush();
		const origSessionFile = sessionManagerA.getSessionFile();
		expect(origSessionFile).toBeDefined();
		const origSessionId = sessionManagerA.getSessionId();
		expect(sessionManagerA.getCwd()).toBe(projectA);

		// Fork into Project B with a custom title
		const forkResult = await sessionManagerA.fork({
			targetCwd: projectB,
			title: "Project B Workspace",
		});

		expect(forkResult).toBeDefined();
		expect(forkResult?.newSessionId).not.toBe(origSessionId);
		expect(forkResult?.newCwd).toBe(projectB);
		expect(forkResult?.newSessionFile).toBeDefined();

		// New session file must exist and be in Project B's session directory
		const newSessionFile = forkResult!.newSessionFile;
		expect(fs.existsSync(newSessionFile)).toBe(true);
		expect(newSessionFile).not.toBe(origSessionFile);

		// Read new session header
		const content = fs.readFileSync(newSessionFile, "utf-8");
		const lines = content.trim().split("\n");
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(forkResult!.newSessionId);
		expect(header.cwd).toBe(projectB);
		expect(header.title).toBe("Project B Workspace");
		expect(header.parentSession).toBe(origSessionId);

		// Verify message history was preserved
		const messageEntries = lines.slice(1).map(l => JSON.parse(l));
		expect(messageEntries.some(e => e.type === "message" && e.message?.content?.[0]?.text === "Hello from Project A")).toBe(true);

		// Verify original session file still exists in Project A with original cwd
		expect(fs.existsSync(origSessionFile!)).toBe(true);
		const origContent = fs.readFileSync(origSessionFile!, "utf-8");
		const origHeader = JSON.parse(origContent.trim().split("\n")[0]);
		expect(origHeader.cwd).toBe(projectA);
		expect(origHeader.id).toBe(origSessionId);
	});

	it("ForkSessionTool parses targetDir safely and expands paths", async () => {
		let forkedTarget: string | undefined;
		let forkedTitle: string | undefined;

		const mockSession: Partial<ToolSession> = {
			fork: async (options?: { targetCwd?: string; title?: string }) => {
				forkedTarget = options?.targetCwd;
				forkedTitle = options?.title;
				return {
					oldSessionFile: "/old.jsonl",
					newSessionFile: "/new.jsonl",
					newSessionId: "new-id-123",
					newCwd: options?.targetCwd ?? projectA,
				};
			},
		};

		const tool = new ForkSessionTool(mockSession as ToolSession);

		// Test with confirmed: true and a targetDir
		const result = await tool.execute("call_1", {
			targetDir: projectB,
			title: "Forked to B",
			confirmed: true,
		});

		expect(forkedTarget).toBe(projectB);
		expect(forkedTitle).toBe("Forked to B");
		expect(result.content[0].type).toBe("text");
		const textContent = result.content[0] as { type: string; text: string };
		expect(textContent.text).toContain(projectB);
		expect(textContent.text).toContain("new-id-123");
	});

	it("resolveToCwd correctly handles relative paths and tildes", () => {
		const home = os.homedir();
		expect(resolveToCwd("~/test-project", projectA)).toBe(path.join(home, "test-project"));
		expect(resolveToCwd("./sub-folder", projectA)).toBe(path.join(projectA, "sub-folder"));
		expect(resolveToCwd(projectB, projectA)).toBe(projectB);
	});
});
