/**
 * Battle Tool — Speculative multi-candidate execution in isolated git worktrees.
 *
 * Runs competing candidates in parallel git worktrees, executes verification tests,
 * and identifies or auto-merges the best solution.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { runBattle } from "../battle/battle-runner";
import type { BattleConfig } from "../battle/types";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const battleSchema = z.object({
	objective: z.string().describe("The problem or feature description for the competing candidates to solve."),
	testCommand: z
		.string()
		.optional()
		.describe("Verification command to validate candidate solutions (e.g. 'bun test', 'npm test', 'pytest')."),
	candidatesCount: z
		.number()
		.int()
		.min(2)
		.max(5)
		.optional()
		.default(2)
		.describe("Number of parallel speculative candidate branches to spawn (default: 2, max: 5)."),
	autoMerge: z
		.boolean()
		.optional()
		.default(false)
		.describe("Whether to automatically merge the winning candidate branch if all tests pass."),
});

export type BattleParams = z.infer<typeof battleSchema>;

export class BattleTool implements AgentTool<typeof battleSchema> {
	readonly name = "battle_solve";
	readonly approval = "write" as const;
	readonly label = "Battle Solve";
	readonly description =
		"Speculative Multi-Worktree Battle Mode: Launches parallel candidate solutions in isolated git worktrees, executes verification test suites, scores diffs, and returns or merges the winning branch.";
	readonly parameters = battleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Speculative multi-candidate worktree competition with automated test verification";

	constructor(private readonly session?: ToolSession) {}

	static createIf(session: ToolSession): BattleTool | null {
		return new BattleTool(session);
	}

	async execute(
		_id: string,
		params: BattleParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const cwd = this.session?.cwd ?? process.cwd();
		const battleId = `battle-${Date.now()}`;
		const count = params.candidatesCount ?? 2;

		const candidates = Array.from({ length: count }, (_, i) => ({
			id: `candidate-${i + 1}`,
			label: `Candidate ${i + 1}`,
			prompt: params.objective,
		}));

		const config: BattleConfig = {
			id: battleId,
			objective: params.objective,
			testCommand: params.testCommand,
			candidates,
			autoMerge: params.autoMerge ?? false,
		};

		try {
			const verdict = await runBattle(config, cwd, {
				cleanupLosers: true,
			});

			const summaryLines = [
				`### Battle Mode Completed [${verdict.battleId}]`,
				verdict.reasoning,
				"",
				"**Candidate Results:**",
			];

			for (const r of verdict.results) {
				const isWinner = r.candidateId === verdict.winnerCandidateId;
				const mark = isWinner ? "🏆 [WINNER]" : "  ";
				const testStatus =
					r.testPassed === true ? "✅ Tests Passed" : r.testPassed === false ? "❌ Tests Failed" : "⚠️ No Tests";
				summaryLines.push(
					`- ${mark} **${r.candidateId}** (${r.branchName}): ${testStatus} | Changed ${r.metrics.filesChanged} files (+${r.metrics.additions}, -${r.metrics.deletions}) in ${r.metrics.elapsedMs}ms`,
				);
			}

			if (verdict.merged) {
				summaryLines.push("\n✨ **The winning branch has been merged into HEAD.**");
			}

			return {
				content: [{ type: "text", text: summaryLines.join("\n") }],
				details: { verdict },
			};
		} catch (error: any) {
			throw new ToolError(`Battle execution failed: ${error.message || String(error)}`);
		}
	}
}
