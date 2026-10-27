import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { runBattle } from "../battle-runner";
import type { BattleConfig } from "../types";

const exec = promisify(execFile);

describe("Battle Runner Orchestration", () => {
	let testRepoDir: string;

	beforeAll(async () => {
		testRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-battle-runner-repo-"));
		await exec("git", ["init", "-b", "main"], { cwd: testRepoDir });
		await exec("git", ["config", "user.email", "test@aery.ai"], { cwd: testRepoDir });
		await exec("git", ["config", "user.name", "Aery Test"], { cwd: testRepoDir });

		// Add package.json with a test script
		const pkg = {
			name: "test-battle-pkg",
			scripts: {
				test: "cat test.txt | grep 'PASS'",
			},
		};
		await fs.writeFile(path.join(testRepoDir, "package.json"), JSON.stringify(pkg, null, 2));
		await fs.writeFile(path.join(testRepoDir, "test.txt"), "FAIL\n");
		await exec("git", ["add", "."], { cwd: testRepoDir });
		await exec("git", ["commit", "-m", "Initial commit"], { cwd: testRepoDir });
	});

	afterAll(async () => {
		try {
			await fs.rm(testRepoDir, { recursive: true, force: true });
		} catch {}
	});

	it("executes parallel battle candidates, runs tests, and picks the winner", async () => {
		const battleConfig: BattleConfig = {
			id: `test-battle-${Date.now()}`,
			objective: "Make the test pass",
			testCommand: "npm run test",
			candidates: [
				{
					id: "candidate-a",
					label: "Flawed Candidate",
				},
				{
					id: "candidate-b",
					label: "Winning Candidate",
				},
			],
		};

		// Mock handler that executes different file changes per candidate
		const mockWorker = async (worktreePath: string, candidateId: string) => {
			if (candidateId === "candidate-b") {
				await fs.writeFile(path.join(worktreePath, "test.txt"), "PASS\n");
				await exec("git", ["add", "."], { cwd: worktreePath });
				await exec("git", ["commit", "-m", "Fixed test"], { cwd: worktreePath });
			} else {
				await fs.writeFile(path.join(worktreePath, "test.txt"), "STILL_FAILING\n");
				await exec("git", ["add", "."], { cwd: worktreePath });
				await exec("git", ["commit", "-m", "Broken change"], { cwd: worktreePath });
			}
		};

		const verdict = await runBattle(battleConfig, testRepoDir, {
			worker: mockWorker,
			cleanupLosers: true,
		});

		expect(verdict.winnerCandidateId).toBe("candidate-b");
		expect(verdict.results.length).toBe(2);

		const winnerResult = verdict.results.find(r => r.candidateId === "candidate-b");
		expect(winnerResult?.testPassed).toBe(true);

		const loserResult = verdict.results.find(r => r.candidateId === "candidate-a");
		expect(loserResult?.testPassed).toBe(false);
	});
});
