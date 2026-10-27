import { describe, expect, it } from "bun:test";
import { type CandidateRunResult, isBattleSuccessful, summarizeBattleResults } from "../types";

describe("Battle Mode Types & Helpers", () => {
	it("summarizeBattleResults selects highest-scoring test-passing candidate", () => {
		const results: CandidateRunResult[] = [
			{
				candidateId: "c1",
				worktreePath: "/tmp/wt1",
				branchName: "battle-c1",
				success: true,
				testPassed: false,
				metrics: { elapsedMs: 1200, filesChanged: 2, additions: 20, deletions: 5 },
			},
			{
				candidateId: "c2",
				worktreePath: "/tmp/wt2",
				branchName: "battle-c2",
				success: true,
				testPassed: true,
				metrics: { elapsedMs: 1500, filesChanged: 1, additions: 10, deletions: 2 },
			},
		];

		const summary = summarizeBattleResults(results);
		expect(summary.totalCandidates).toBe(2);
		expect(summary.testPassingCandidates).toBe(1);
		expect(summary.suggestedWinnerId).toBe("c2");
	});

	it("isBattleSuccessful checks if any candidate succeeded and passed tests", () => {
		const failingResults: CandidateRunResult[] = [
			{
				candidateId: "c1",
				worktreePath: "/tmp/wt1",
				branchName: "battle-c1",
				success: false,
				testPassed: false,
				metrics: { elapsedMs: 500, filesChanged: 0, additions: 0, deletions: 0 },
			},
		];
		expect(isBattleSuccessful(failingResults)).toBe(false);

		const passingResults: CandidateRunResult[] = [
			{
				candidateId: "c2",
				worktreePath: "/tmp/wt2",
				branchName: "battle-c2",
				success: true,
				testPassed: true,
				metrics: { elapsedMs: 1000, filesChanged: 1, additions: 5, deletions: 0 },
			},
		];
		expect(isBattleSuccessful(passingResults)).toBe(true);
	});
});
