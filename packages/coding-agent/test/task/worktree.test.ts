import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@aryee337/aery-engine";
import {
	captureBaseline,
	captureDeltaPatch,
	commitToBranch,
	ensureIsolation,
	getGitNoIndexNullPath,
	mergeTaskBranches,
	parseIsolationMode,
} from "../../src/task/worktree";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createGitRepo(): Promise<{ baseBranch: string; repo: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "aery-worktree-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "merged.txt"), "base version\n");
	await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return {
		baseBranch: await runGit(repo, ["branch", "--show-current"]),
		repo,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("maps every isolation mode to the native backend contract", () => {
		expect(parseIsolationMode("none")).toBeUndefined();
		expect(parseIsolationMode("auto")).toBeUndefined();
		expect(parseIsolationMode("apfs")).toBe(natives.IsoBackendKind.Apfs);
		expect(parseIsolationMode("btrfs")).toBe(natives.IsoBackendKind.Btrfs);
		expect(parseIsolationMode("zfs")).toBe(natives.IsoBackendKind.Zfs);
		expect(parseIsolationMode("reflink")).toBe(natives.IsoBackendKind.LinuxReflink);
		expect(parseIsolationMode("overlayfs")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("fuse-overlay")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("fuse-projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("block-clone")).toBe(natives.IsoBackendKind.WindowsBlockClone);
		expect(parseIsolationMode("rcopy")).toBe(natives.IsoBackendKind.Rcopy);
		expect(parseIsolationMode("worktree")).toBe(natives.IsoBackendKind.Rcopy);
	});

	it("retries isoResolve candidates when a backend is path-unavailable", async () => {
		const { repo } = await createGitRepo();
		const unavailable = new Error("ISO_UNAVAILABLE: btrfs source is not a subvolume");
		const isoResolve = vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Btrfs,
			candidates: [natives.IsoBackendKind.Btrfs, natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		const isoStart = vi
			.spyOn(natives, "isoStart")
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce(undefined);
		vi.spyOn(natives, "isoIsUnavailableError").mockImplementation(message => message.startsWith("ISO_UNAVAILABLE:"));

		const handle = await ensureIsolation(repo, "retry-path-unavailable");

		expect(isoResolve).toHaveBeenCalledWith(null);
		expect(isoStart.mock.calls.map(call => call[0])).toEqual([
			natives.IsoBackendKind.Btrfs,
			natives.IsoBackendKind.Rcopy,
		]);
		expect(handle.backend).toBe(natives.IsoBackendKind.Rcopy);
		expect(handle.fellBack).toBe(true);
		expect(handle.fallbackReason).toBe(unavailable.message);
	});

	it("does not pop an unrelated pre-existing stash when the working tree is clean", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "preexisting.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		const before = await runGit(repo, ["stash", "list"]);

		const result = await mergeTaskBranches(repo, []);

		expect(result).toEqual({ failed: [], merged: [] });
		expect(await runGit(repo, ["stash", "list"])).toBe(before);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("restores staged changes with index preservation after merging task branches", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-staged";
		await runGit(repo, ["checkout", "-b", taskBranch]);
		await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "task-change"]);
		await runGit(repo, ["checkout", baseBranch]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
		await runGit(repo, ["add", "staged.txt"]);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({ failed: [], merged: [taskBranch] });
		expect(await fs.readFile(path.join(repo, "merged.txt"), "utf8")).toBe("task branch change\n");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");
		expect(await runGit(repo, ["diff", "--cached", "--", "staged.txt"])).toContain("+local staged change");
		expect(await runGit(repo, ["stash", "list"])).toBe("");
	});

	it("subtracts baseline dirty state even when the task commits it", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "merged.txt"), "baseline dirty change\n");
		await fs.writeFile(path.join(repo, "preexisting.txt"), "baseline untracked\n");
		const baseline = await captureBaseline(repo);

		await runGit(repo, ["add", "-A"]);
		await runGit(repo, ["commit", "-m", "baseline committed inside isolation"]);
		await fs.writeFile(path.join(repo, "task.txt"), "task output\n");
		await runGit(repo, ["add", "task.txt"]);
		await runGit(repo, ["commit", "-m", "task output"]);

		const delta = await captureDeltaPatch(repo, baseline);

		expect(delta.nestedPatches).toEqual([]);
		expect(delta.rootPatch).toContain("task.txt");
		expect(delta.rootPatch).toContain("+task output");
		expect(delta.rootPatch).not.toContain("baseline dirty change");
		expect(delta.rootPatch).not.toContain("preexisting.txt");
	});

	describe("with baseline WIP overlapping the agent's changes (#4136)", () => {
		let parent: string;
		let isolation: string;

		beforeEach(async () => {
			parent = await fs.mkdtemp(path.join(os.tmpdir(), "aery-parent-"));
			isolation = await fs.mkdtemp(path.join(os.tmpdir(), "aery-isolation-"));
			tempDirs.push(parent, isolation);

			await runGit(parent, ["init"]);
			await runGit(parent, ["config", "user.email", "parent@example.com"]);
			await runGit(parent, ["config", "user.name", "Parent User"]);
			await fs.writeFile(path.join(parent, "README.md"), "hello\n");
			await runGit(parent, ["add", "README.md"]);
			await runGit(parent, ["commit", "-q", "-m", "initial"]);

			// Clone parent into isolation
			await runGit(parent, ["clone", "-q", "--no-hardlinks", "--local", parent, isolation]);
			await runGit(isolation, ["config", "user.email", "agent@example.com"]);
			await runGit(isolation, ["config", "user.name", "Agent User"]);
		});

		async function seedWipFileFromParent(destRoot: string, relPath: string): Promise<void> {
			await fs.mkdir(path.join(destRoot, path.dirname(relPath)), { recursive: true });
			await fs.copyFile(path.join(parent, relPath), path.join(destRoot, relPath));
		}

		it("commits an agent-only delta via --3way when WIP and agent modify unrelated hunks of the same tracked file", async () => {
			const fixture = "src/foo.py";
			const head = Array.from({ length: 40 }, (_, i) => `# line ${i + 1}\n`).join("");
			await fs.mkdir(path.join(parent, "src"), { recursive: true });
			await fs.writeFile(path.join(parent, fixture), head);
			await runGit(parent, ["add", "."]);
			await runGit(parent, ["commit", "-q", "-m", "add fixture"]);

			// Re-clone isolation to get the fixture
			await fs.rm(isolation, { recursive: true, force: true });
			await runGit(parent, ["clone", "-q", "--no-hardlinks", "--local", parent, isolation]);
			await runGit(isolation, ["config", "user.email", "agent@example.com"]);
			await runGit(isolation, ["config", "user.name", "Agent User"]);

			// Parent WIP: change line 10
			const wipLines = head.split("\n");
			wipLines[9] = "# line 10 thinkingLevel: medium";
			await fs.writeFile(path.join(parent, fixture), wipLines.join("\n"));
			await seedWipFileFromParent(isolation, fixture);

			// Agent modifies line 30
			const agentLines = wipLines.slice();
			agentLines[29] = "# line 30 def new_func()";
			await fs.writeFile(path.join(isolation, fixture), agentLines.join("\n"));

			const baseline = await captureBaseline(parent);
			const result = await commitToBranch(isolation, baseline, "wip-tracked-file", undefined);
			expect(result?.branchName).toBe("aery/task/wip-tracked-file");

			const branchDiff = await runGit(parent, ["show", "--pretty=format:", result!.branchName!]);
			expect(branchDiff).toContain("+# line 30 def new_func()");
			expect(branchDiff).not.toContain("thinkingLevel: medium");
		});

		it("commits an untracked WIP file that the agent modifies inside isolation", async () => {
			await fs.mkdir(path.join(parent, "src"), { recursive: true });
			await fs.writeFile(path.join(parent, "src/new.py"), "WIP header\nunchanged\n");
			await fs.mkdir(path.join(isolation, "src"), { recursive: true });
			await fs.copyFile(path.join(parent, "src/new.py"), path.join(isolation, "src/new.py"));

			await fs.writeFile(path.join(isolation, "src/new.py"), "WIP header\nagent-edit\n");

			const baseline = await captureBaseline(parent);
			expect(baseline.root.untracked).toContain("src/new.py");
			const result = await commitToBranch(isolation, baseline, "wip-untracked", undefined);
			expect(result?.branchName).toBe("aery/task/wip-untracked");

			const branchDiff = await runGit(parent, ["show", "--pretty=format:", result!.branchName!]);
			expect(branchDiff).toContain("new file mode");
			expect(branchDiff).toContain("src/new.py");
			expect(branchDiff).toContain("+WIP header");
			expect(branchDiff).toContain("+agent-edit");
		});

		it("commits a staged-new WIP file that the agent modifies inside isolation", async () => {
			await fs.writeFile(path.join(parent, "notes.md"), "l1\nl2\nl3\n");
			await runGit(parent, ["add", "notes.md"]);
			await fs.copyFile(path.join(parent, "notes.md"), path.join(isolation, "notes.md"));
			await runGit(isolation, ["add", "notes.md"]);

			await fs.writeFile(path.join(isolation, "notes.md"), "l1\nl2 agent\nl3\n");

			const baseline = await captureBaseline(parent);
			const result = await commitToBranch(isolation, baseline, "wip-staged-new", undefined);
			expect(result?.branchName).toBe("aery/task/wip-staged-new");

			const branchDiff = await runGit(parent, ["show", "--pretty=format:", result!.branchName!]);
			expect(branchDiff).toContain("new file mode");
			expect(branchDiff).toContain("notes.md");
			expect(branchDiff).toContain("+l2 agent");
		});

		it("does not leak WIP-only files into the branch commit when the agent leaves them untouched", async () => {
			await fs.mkdir(path.join(parent, "src"), { recursive: true });
			await fs.writeFile(path.join(parent, "src/wanted.py"), "unchanged\n");
			await fs.writeFile(path.join(parent, "src/wip-only.py"), "unchanged\n");
			await runGit(parent, ["add", "."]);
			await runGit(parent, ["commit", "-q", "-m", "seed"]);

			// Re-clone
			await fs.rm(isolation, { recursive: true, force: true });
			await runGit(parent, ["clone", "-q", "--no-hardlinks", "--local", parent, isolation]);
			await runGit(isolation, ["config", "user.email", "agent@example.com"]);
			await runGit(isolation, ["config", "user.name", "Agent User"]);

			await fs.writeFile(path.join(parent, "src/wip-only.py"), "wip edit\n");
			await fs.writeFile(path.join(parent, "src/wanted.py"), "wip mixed\n");
			await fs.copyFile(path.join(parent, "src/wip-only.py"), path.join(isolation, "src/wip-only.py"));
			await fs.copyFile(path.join(parent, "src/wanted.py"), path.join(isolation, "src/wanted.py"));

			await fs.writeFile(path.join(parent, "user-wip.txt"), "user wip\n");
			await fs.copyFile(path.join(parent, "user-wip.txt"), path.join(isolation, "user-wip.txt"));

			// Agent only changes wanted.py
			await fs.writeFile(path.join(isolation, "src/wanted.py"), "wip mixed\nagent change\n");

			const baseline = await captureBaseline(parent);
			const result = await commitToBranch(isolation, baseline, "wip-untouched", undefined);
			expect(result?.branchName).toBe("aery/task/wip-untouched");

			const branchDiff = await runGit(parent, ["show", "--pretty=format:", result!.branchName!]);
			expect(branchDiff).toContain("src/wanted.py");
			expect(branchDiff).toContain("+agent change");
			expect(branchDiff).not.toContain("wip-only.py");
			expect(branchDiff).not.toContain("user-wip.txt");
		});
	});
});
