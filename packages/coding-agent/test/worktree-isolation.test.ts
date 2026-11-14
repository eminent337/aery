import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EnterWorktreeTool, ExitWorktreeTool } from "../src/tools/worktree";
import * as git from "../src/utils/git";

describe("Worktree Isolation Tools", () => {
	it("should initialize tools properly with name and approval", () => {
		const mockSession: any = { cwd: process.cwd() };
		const enterTool = new EnterWorktreeTool(mockSession);
		const exitTool = new ExitWorktreeTool(mockSession);

		expect(enterTool.name).toBe("enter_worktree");
		expect(enterTool.approval).toBe("execute");
		expect(exitTool.name).toBe("exit_worktree");
		expect(exitTool.approval).toBe("execute");
	});

	it("should fail gracefully if not in a git repo", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "non-git-"));
		const prev = process.cwd();
		process.chdir(tempDir);
		try {
			const mockSession: any = { cwd: tempDir };
			const enterTool = new EnterWorktreeTool(mockSession);
			expect(enterTool.execute("call-1", {})).rejects.toThrow("active git repository");
		} finally {
			process.chdir(prev);
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
