import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@aryee337/aery-utils";
import { SessionManager } from "../../src/session/session-manager";
import { ForkSessionTool } from "../../src/tools/ai-autonomous-tools";
import type { ToolSession } from "../../src/tools/index";

describe("SessionManager.fork with targetCwd", () => {
	it("forks session in-place when targetCwd is omitted", async () => {
		using tempDir = TempDir.createSync("@aery-fork-inplace-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "test message", timestamp: 1 });
		await session.flush();

		const oldId = session.getSessionId();
		const oldFile = session.getSessionFile()!;

		const forkResult = await session.fork();
		expect(forkResult).toBeDefined();
		expect(forkResult?.newSessionId).not.toBe(oldId);
		expect(forkResult?.newCwd).toBe(tempDir.path());
		expect(session.getCwd()).toBe(tempDir.path());
		expect(session.getSessionFile()).not.toBe(oldFile);

		// File on disk has matching cwd and parentSession
		const content = await Bun.file(forkResult!.newSessionFile).text();
		const firstLine = JSON.parse(content.split("\n")[0]!);
		expect(firstLine.id).toBe(forkResult?.newSessionId);
		expect(firstLine.cwd).toBe(tempDir.path());
		expect(firstLine.parentSession).toBe(oldId);
	});

	it("forks session into a different project directory and sets header cwd and breadcrumbs", async () => {
		using sourceDir = TempDir.createSync("@aery-fork-src-");
		using targetDir = TempDir.createSync("@aery-fork-target-");

		const session = SessionManager.create(sourceDir.path());
		session.appendMessage({ role: "user", content: "hello from source", timestamp: 1 });
		session.appendMessage({ role: "user", content: "second user prompt", timestamp: 2 });
		await session.flush();

		const oldId = session.getSessionId();

		const forkResult = await session.fork({
			targetCwd: targetDir.path(),
			title: "Forked Project Title",
		});

		expect(forkResult).toBeDefined();
		expect(forkResult?.newCwd).toBe(targetDir.path());
		expect(session.getCwd()).toBe(targetDir.path());
		expect(session.getSessionName()).toBe("Forked Project Title");

		// Target file exists and has targetCwd in line 1
		expect(fs.existsSync(forkResult!.newSessionFile)).toBe(true);
		const content = await Bun.file(forkResult!.newSessionFile).text();
		const lines = content.trim().split("\n");
		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");
		expect(header.cwd).toBe(targetDir.path());
		expect(header.title).toBe("Forked Project Title");
		expect(header.parentSession).toBe(oldId);

		// Messages were preserved
		expect(lines.length).toBeGreaterThan(1);
		const msg1 = JSON.parse(lines[1]!);
		expect(msg1.type).toBe("message");
		expect(msg1.message.content).toBe("hello from source");
	});
});

describe("ForkSessionTool (ai_fork_session)", () => {
	it("allows LLM to fork into a target directory safely", async () => {
		using targetDir = TempDir.createSync("@aery-tool-dest-");

		let passedOptions: { targetCwd?: string; title?: string; messageIndex?: number } | undefined;
		const mockSession: Partial<ToolSession> = {
			fork: async options => {
				passedOptions = options;
				return {
					oldSessionFile: "/old/file.jsonl",
					newSessionFile: path.join(targetDir.path(), "new.jsonl"),
					newSessionId: "019-new-id",
					newCwd: targetDir.path(),
				};
			},
		};

		const tool = new ForkSessionTool(mockSession as ToolSession);
		const result = await tool.execute("call_1", {
			confirmed: true,
			targetDir: targetDir.path(),
			title: "New Autonomous Fork",
		});

		expect(passedOptions?.targetCwd).toBe(targetDir.path());
		expect(passedOptions?.title).toBe("New Autonomous Fork");
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain(targetDir.path());
		expect((result.content[0] as { text: string }).text).toContain("019-new-id");
	});
});
