import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { AutonomousHealer } from "../autonomous-healer";

const exec = promisify(execFile);

describe("Autonomous Self-Healing Engine (aery heal / /heal)", () => {
	let testRepoDir: string;

	beforeAll(async () => {
		testRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-healer-test-repo-"));
		await exec("git", ["init", "-b", "main"], { cwd: testRepoDir });
		await exec("git", ["config", "user.email", "healer@aery.ai"], { cwd: testRepoDir });
		await exec("git", ["config", "user.name", "Aery Healer"], { cwd: testRepoDir });
		await fs.writeFile(path.join(testRepoDir, "calc.js"), "module.exports = { add: (a, b) => a - b };\n");
		await exec("git", ["add", "."], { cwd: testRepoDir });
		await exec("git", ["commit", "-m", "Initial broken commit"], { cwd: testRepoDir });
	});

	afterAll(async () => {
		try {
			await fs.rm(testRepoDir, { recursive: true, force: true });
		} catch {}
	});

	it("returns early with 0 attempts if the command already passes", async () => {
		const healer = new AutonomousHealer(testRepoDir);
		const result = await healer.heal("echo 'pass'", undefined, { cwd: testRepoDir });

		expect(result.success).toBe(true);
		expect(result.attempts).toBe(0);
		expect(result.repairedDiff).toBeUndefined();
		expect(result.applied).toBe(false);
		expect(result.summary).toContain("no healing required");
	});

	it("heals a failing command using repairStrategy callback and returns patch diff", async () => {
		const healer = new AutonomousHealer(testRepoDir);
		const testCmd = "node -e \"const { add } = require('./calc.js'); if (add(2, 3) !== 5) process.exit(1);\"";

		const result = await healer.heal(
			testCmd,
			async (_err, worktreePath) => {
				const calcPath = path.join(worktreePath, "calc.js");
				await fs.writeFile(calcPath, "module.exports = { add: (a, b) => a + b };\n");
				return true;
			},
			{ cwd: testRepoDir, autoApply: false, maxAttempts: 2 },
		);

		expect(result.success).toBe(true);
		expect(result.attempts).toBe(1);
		expect(result.applied).toBe(false);
		expect(result.repairedDiff).toBeDefined();
		expect(result.repairedDiff).toContain("a + b");
		expect(result.summary).toContain("Successfully healed");
	});

	it("auto-applies repaired patch to base repo when autoApply is true", async () => {
		const healer = new AutonomousHealer(testRepoDir);
		const testCmd = "node -e \"const { add } = require('./calc.js'); if (add(2, 3) !== 5) process.exit(1);\"";

		const result = await healer.heal(
			testCmd,
			async (_err, worktreePath) => {
				const calcPath = path.join(worktreePath, "calc.js");
				await fs.writeFile(calcPath, "module.exports = { add: (a, b) => a + b };\n");
				return true;
			},
			{ cwd: testRepoDir, autoApply: true, maxAttempts: 2 },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toBe(true);

		// Now verify that the command succeeds in the base repo itself
		const check = await exec(
			"node",
			["-e", "const { add } = require('./calc.js'); if (add(2, 3) !== 5) process.exit(1);"],
			{
				cwd: testRepoDir,
			},
		);
		expect(check.stderr).toBe("");
	});

	it("reports failure when max attempts reached without fix", async () => {
		const healer = new AutonomousHealer(testRepoDir);
		const failingCmd = "node -e 'process.exit(2)'";

		const result = await healer.heal(
			failingCmd,
			async () => {
				// No-op strategy
				return true;
			},
			{ cwd: testRepoDir, autoApply: false, maxAttempts: 2 },
		);

		expect(result.success).toBe(false);
		expect(result.attempts).toBe(2);
		expect(result.summary).toContain("Failed to heal command after 2 attempt(s)");
	});
});
