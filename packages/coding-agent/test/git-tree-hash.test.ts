import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGitTreeHash, getModifiedFilesSince, hasRepoChangedSince } from "../src/utils/git-tree-hash";

async function runGit(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
	}
	return stdout.trim();
}

describe("Git Tree Hash Change Detector", () => {
	let testRepoDir: string;
	let nonGitDir: string;

	beforeEach(async () => {
		testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-tree-hash-repo-"));
		nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-tree-hash-nongit-"));

		await runGit(["init", "-q"], testRepoDir);
		await runGit(["config", "user.name", "Test User"], testRepoDir);
		await runGit(["config", "user.email", "test@example.com"], testRepoDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(testRepoDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
		try {
			fs.rmSync(nonGitDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("returns a 40-character hex tree hash for an initial commit", async () => {
		const filePath = path.join(testRepoDir, "hello.txt");
		fs.writeFileSync(filePath, "hello world\n", "utf8");
		await runGit(["add", "hello.txt"], testRepoDir);
		await runGit(["commit", "-qm", "Initial commit"], testRepoDir);

		const hash = await getGitTreeHash(testRepoDir);
		expect(hash).not.toBeNull();
		expect(typeof hash).toBe("string");
		expect(hash).toHaveLength(40);
		expect(hash).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns changed: false when repository is unmodified", async () => {
		const filePath = path.join(testRepoDir, "readme.md");
		fs.writeFileSync(filePath, "# Readme\n", "utf8");
		await runGit(["add", "readme.md"], testRepoDir);
		await runGit(["commit", "-qm", "Add readme"], testRepoDir);

		const initialHash = await getGitTreeHash(testRepoDir);
		expect(initialHash).not.toBeNull();

		const result = await hasRepoChangedSince(testRepoDir, initialHash);
		expect(result.changed).toBe(false);
		expect(result.currentHash).toBe(initialHash);
	});

	it("detects modifications and returns changed: true", async () => {
		const filePath = path.join(testRepoDir, "code.ts");
		fs.writeFileSync(filePath, "const x = 1;\n", "utf8");
		await runGit(["add", "code.ts"], testRepoDir);
		await runGit(["commit", "-qm", "Add code"], testRepoDir);

		const initialHash = await getGitTreeHash(testRepoDir);
		expect(initialHash).not.toBeNull();

		// Modify file unstaged
		fs.writeFileSync(filePath, "const x = 2;\n", "utf8");

		const result = await hasRepoChangedSince(testRepoDir, initialHash);
		expect(result.changed).toBe(true);
		expect(result.currentHash).not.toBeNull();
		expect(result.currentHash).not.toBe(initialHash);
	});

	it("lists modified files since a previous tree hash", async () => {
		const file1 = path.join(testRepoDir, "file1.txt");
		const file2 = path.join(testRepoDir, "file2.txt");
		fs.writeFileSync(file1, "one\n", "utf8");
		fs.writeFileSync(file2, "two\n", "utf8");
		await runGit(["add", "file1.txt", "file2.txt"], testRepoDir);
		await runGit(["commit", "-qm", "Commit files"], testRepoDir);

		const initialHash = await getGitTreeHash(testRepoDir);
		expect(initialHash).not.toBeNull();

		// Modify file1
		fs.writeFileSync(file1, "one modified\n", "utf8");

		const modifiedFiles = await getModifiedFilesSince(testRepoDir, initialHash!);
		expect(modifiedFiles).toEqual(["file1.txt"]);

		// Also modify file2
		fs.writeFileSync(file2, "two modified\n", "utf8");
		const modifiedBoth = await getModifiedFilesSince(testRepoDir, initialHash!);
		expect(modifiedBoth).toContain("file1.txt");
		expect(modifiedBoth).toContain("file2.txt");
		expect(modifiedBoth).toHaveLength(2);
	});

	it("gracefully supports composite hash with colon separator in getModifiedFilesSince", async () => {
		const file1 = path.join(testRepoDir, "app.ts");
		fs.writeFileSync(file1, "console.log(1);\n", "utf8");
		await runGit(["add", "app.ts"], testRepoDir);
		await runGit(["commit", "-qm", "Add app.ts"], testRepoDir);

		const initialHash = await getGitTreeHash(testRepoDir);
		fs.writeFileSync(file1, "console.log(2);\n", "utf8");

		// Pass composite hash format: <tree_oid>:<dirty_digest>
		const compositeHash = `${initialHash}:dirty12345678`;
		const modifiedFiles = await getModifiedFilesSince(testRepoDir, compositeHash);
		expect(modifiedFiles).toEqual(["app.ts"]);
	});

	it("returns null gracefully on a non-git directory", async () => {
		const nonGitHash = await getGitTreeHash(nonGitDir);
		expect(nonGitHash).toBeNull();

		const changeResult = await hasRepoChangedSince(nonGitDir, "dummy-hash");
		expect(changeResult.changed).toBe(true);
		expect(changeResult.currentHash).toBeNull();

		const modified = await getModifiedFilesSince(nonGitDir, "dummy-hash");
		expect(modified).toEqual([]);
	});

	it("returns null gracefully on non-existent directory", async () => {
		const nonExistentDir = path.join(os.tmpdir(), "non-existent-dir-987654321");
		const hash = await getGitTreeHash(nonExistentDir);
		expect(hash).toBeNull();
	});

	it("handles fresh git repository with no commits", async () => {
		const emptyRepoHash = await getGitTreeHash(testRepoDir);
		expect(emptyRepoHash).not.toBeNull();
		expect(typeof emptyRepoHash).toBe("string");
		expect(emptyRepoHash).toHaveLength(40);
	});
});
