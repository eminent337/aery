import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitCheckpointService } from "@aryee337/aery-core/checkpoint";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import {
	type CheckpointState,
	CheckpointTool,
	createCheckpointTool,
	createRewindTool,
	RewindTool,
} from "../../src/tools/checkpoint";
import { ToolError } from "../../src/tools/tool-errors";

const execAsync = promisify(execFile);

describe("Checkpoint and Rewind Autonomous Tools", () => {
	const tempDirs: string[] = [];

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function initGitRepo(): Promise<string> {
		const dir = await createTempDir("aery-tool-test-repo-");
		await execAsync("git", ["init"], { cwd: dir });
		await execAsync("git", ["config", "user.name", "Aery Tool Test"], { cwd: dir });
		await execAsync("git", ["config", "user.email", "tooltest@aery.local"], { cwd: dir });

		// Baseline commit
		await fs.writeFile(path.join(dir, "service.ts"), 'export const status = "healthy";\n', "utf8");
		await execAsync("git", ["add", "service.ts"], { cwd: dir });
		await execAsync("git", ["commit", "-m", "initial baseline"], { cwd: dir });

		return dir;
	}

	function createMockSession(options: {
		cwd: string;
		taskDepth?: number;
		sessionId?: string;
		leafId?: string;
		onBranch?: (branchFromId: string) => void;
	}): ToolSession {
		let state: CheckpointState | undefined;
		const settings = Settings.isolated();

		return {
			cwd: options.cwd,
			hasUI: false,
			taskDepth: options.taskDepth ?? 0,
			settings,
			getSessionId: () => options.sessionId ?? "session-tool-test",
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getCheckpointState: () => state,
			setCheckpointState: (nextState: CheckpointState | null) => {
				state = nextState ?? undefined;
			},
			sessionManager: {
				getLeafId: () => options.leafId ?? "entry-alpha",
				getLeafEntry: () => ({ id: options.leafId ?? "entry-alpha" }),
				getEntries: () => [{ id: options.leafId ?? "entry-alpha" }],
				branch: (branchFromId: string) => {
					options.onBranch?.(branchFromId);
				},
			} as unknown as ToolSession["sessionManager"],
		};
	}

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it("CheckpointTool captures git hidden ref and records state", async () => {
		const repoDir = await initGitRepo();
		const session = createMockSession({
			cwd: repoDir,
			sessionId: "session-cp-test",
			leafId: "entry-cp-1",
		});

		const tool = new CheckpointTool(session);
		const result = await tool.execute("call-cp-1", {
			goal: "Investigate performance bottleneck in database connection pool",
		});

		// Verify result structure and details
		expect(result.details?.goal).toBe("Investigate performance bottleneck in database connection pool");
		expect(result.details?.ref).toBe("refs/aery/checkpoints/session-cp-test/entry-cp-1");
		expect(result.details?.commit).toBeDefined();

		// Verify confirmation text body returned to agent
		const textContent = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(textContent).toContain("Checkpoint created.");
		expect(textContent).toContain("Goal: Investigate performance bottleneck in database connection pool");
		expect(textContent).toContain("Ref: refs/aery/checkpoints/session-cp-test/entry-cp-1");
		expect(textContent).toContain(result.details?.commit ?? "");

		// Verify hidden ref exists in git repository
		const hasRef = await GitCheckpointService.hasCheckpoint({
			cwd: repoDir,
			sessionId: "session-cp-test",
			entryId: "entry-cp-1",
		});
		expect(hasRef).toBe(true);

		// Verify checkpoint state was recorded on session
		const recordedState = session.getCheckpointState?.();
		expect(recordedState).toBeDefined();
		expect(recordedState?.checkpointEntryId).toBe("entry-cp-1");
		expect(recordedState?.ref).toBe("refs/aery/checkpoints/session-cp-test/entry-cp-1");
		expect(recordedState?.commit).toBe(result.details?.commit);
	});

	it("RewindTool restores tracked files and cleans untracked files", async () => {
		const repoDir = await initGitRepo();
		const filePath = path.join(repoDir, "service.ts");
		const untrackedPath = path.join(repoDir, "scratch-test.log");

		let branchedId: string | null = null;
		const session = createMockSession({
			cwd: repoDir,
			sessionId: "session-rewind-test",
			leafId: "entry-rewind-1",
			onBranch: id => {
				branchedId = id;
			},
		});

		// Capture initial checkpoint
		const cpTool = new CheckpointTool(session);
		await cpTool.execute("call-1", { goal: "Exploratory patch" });

		// Simulate agent modifying tracked file and creating untracked scratch file
		await fs.writeFile(filePath, 'export const status = "broken-experimental";\n', "utf8");
		await fs.writeFile(untrackedPath, "temporary crash dump\n", "utf8");

		expect(await fs.readFile(filePath, "utf8")).toBe('export const status = "broken-experimental";\n');
		expect(await fs.exists(untrackedPath)).toBe(true);

		// Execute rewind tool
		const rewindTool = new RewindTool(session);
		const rewindResult = await rewindTool.execute("call-2", {
			report: "Hypothesis invalid: experimental patch caused connection timeouts.",
		});

		// Verify rewind tool details
		expect(rewindResult.details?.rewound).toBe(true);
		expect(rewindResult.details?.report).toBe("Hypothesis invalid: experimental patch caused connection timeouts.");
		expect(rewindResult.details?.ref).toBe("refs/aery/checkpoints/session-rewind-test/entry-rewind-1");

		// Verify confirmation text body
		const textContent = rewindResult.content[0]?.type === "text" ? rewindResult.content[0].text : "";
		expect(textContent).toContain("Rewind completed.");
		expect(textContent).toContain(
			"Restored working tree to refs/aery/checkpoints/session-rewind-test/entry-rewind-1",
		);
		expect(textContent).toContain("Report captured for context replacement.");

		// Verify modified tracked file is restored to baseline
		const restoredContent = await fs.readFile(filePath, "utf8");
		expect(restoredContent).toBe('export const status = "healthy";\n');

		// Verify untracked scratch file was removed
		expect(await fs.exists(untrackedPath)).toBe(false);

		// Verify sessionManager.branch was called
		expect(branchedId as string | null).toBe("entry-rewind-1");
	});

	it("Error handling: rejects subagents and handles invalid states", async () => {
		const repoDir = await initGitRepo();
		const topSession = createMockSession({ cwd: repoDir });
		const subagentSession = createMockSession({ cwd: repoDir, taskDepth: 1 });

		// Subagents rejected
		expect(CheckpointTool.createIf(subagentSession)).toBeNull();
		expect(RewindTool.createIf(subagentSession)).toBeNull();

		const subagentCp = new CheckpointTool(subagentSession);
		let threwCpSubagent = false;
		try {
			await subagentCp.execute("c1", { goal: "Subagent test" });
		} catch (err) {
			threwCpSubagent = true;
			expect(err).toBeInstanceOf(ToolError);
			expect((err as ToolError).message).toContain("Checkpoint not available in subagents.");
		}
		expect(threwCpSubagent).toBe(true);

		const subagentRewind = new RewindTool(subagentSession);
		let threwRewindSubagent = false;
		try {
			await subagentRewind.execute("c2", { report: "Subagent report" });
		} catch (err) {
			threwRewindSubagent = true;
			expect(err).toBeInstanceOf(ToolError);
			expect((err as ToolError).message).toContain("Checkpoint not available in subagents.");
		}
		expect(threwRewindSubagent).toBe(true);

		// Rewind with no active checkpoint throws
		const rewindTool = new RewindTool(topSession);
		let threwNoCheckpoint = false;
		try {
			await rewindTool.execute("c3", { report: "No checkpoint active" });
		} catch (err) {
			threwNoCheckpoint = true;
			expect(err).toBeInstanceOf(ToolError);
			expect((err as ToolError).message).toContain("No active checkpoint.");
		}
		expect(threwNoCheckpoint).toBe(true);

		// Checkpoint with empty goal throws
		const cpTool = new CheckpointTool(topSession);
		let threwEmptyGoal = false;
		try {
			await cpTool.execute("c-empty", { goal: "   " });
		} catch (err) {
			threwEmptyGoal = true;
			expect(err).toBeInstanceOf(ToolError);
			expect((err as ToolError).message).toContain("Goal cannot be empty.");
		}
		expect(threwEmptyGoal).toBe(true);

		// Checkpoint when already active throws
		await cpTool.execute("c4", { goal: "First active checkpoint" });

		let threwAlreadyActive = false;
		try {
			await cpTool.execute("c5", { goal: "Second duplicate checkpoint" });
		} catch (err) {
			threwAlreadyActive = true;
			expect(err).toBeInstanceOf(ToolError);
			expect((err as ToolError).message).toContain("Checkpoint already active.");
		}
		expect(threwAlreadyActive).toBe(true);

		// Rewind with empty report throws
		let threwEmptyReport = false;
		try {
			await rewindTool.execute("c6", { report: "   " });
		} catch (err) {
			threwEmptyReport = true;
			expect(err).toBeInstanceOf(ToolError);
			expect((err as ToolError).message).toContain("Report cannot be empty.");
		}
		expect(threwEmptyReport).toBe(true);
	});

	it("Factory helpers createCheckpointTool and createRewindTool", async () => {
		const repoDir = await initGitRepo();
		const topSession = createMockSession({ cwd: repoDir, taskDepth: 0 });
		const subSession = createMockSession({ cwd: repoDir, taskDepth: 2 });

		const cpTool = createCheckpointTool(topSession);
		expect(cpTool).toBeInstanceOf(CheckpointTool);
		expect(cpTool?.name).toBe("checkpoint");

		const rwTool = createRewindTool(topSession);
		expect(rwTool).toBeInstanceOf(RewindTool);
		expect(rwTool?.name).toBe("rewind");

		// Factory helpers return null for subagents
		expect(createCheckpointTool(subSession)).toBeNull();
		expect(createRewindTool(subSession)).toBeNull();
	});

	it("Handles non-git directories gracefully without crashing", async () => {
		const nonGitDir = await createTempDir("aery-non-git-tool-");
		const session = createMockSession({ cwd: nonGitDir, sessionId: "non-git-session" });

		const cpTool = new CheckpointTool(session);
		const cpResult = await cpTool.execute("ng-1", { goal: "Non git investigation" });
		expect(cpResult.details?.goal).toBe("Non git investigation");
		expect(cpResult.details?.commit).toBeUndefined();
		expect(cpResult.details?.ref).toBeUndefined();

		const rwTool = new RewindTool(session);
		const rwResult = await rwTool.execute("ng-2", { report: "Non git findings report" });
		expect(rwResult.details?.rewound).toBe(true);
		expect(rwResult.details?.report).toBe("Non git findings report");
	});
});
