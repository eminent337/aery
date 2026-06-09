import { describe, expect, it } from "vitest";
import {
	createBudgetRetryBlock,
	createBudgetRetryBlockFromCompletion,
	shouldBlockBudgetRetry,
} from "./budget-retry-guard";

describe("BudgetRetryGuard", () => {
	it("blocks a higher-budget retry of the same failed call", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "inspect repository",
			}),
		).toBe(true);
	});

	it("allows a different agent type", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Plan",
				description: "Plan agent extension",
				prompt: "inspect repository",
			}),
		).toBe(false);
	});

	it("allows same budget", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 100,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "inspect repository",
			}),
		).toBe(false);
	});

	it("allows lower budget", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 50,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "inspect repository",
			}),
		).toBe(false);
	});

	it("allows a different task for the same agent type", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Explore",
				description: "Explore package metadata",
				prompt: "inspect package metadata",
			}),
		).toBe(false);
	});

	it("does not block with no block", () => {
		expect(
			shouldBlockBudgetRetry(undefined, {
				tokenBudget: 1_000,
				subagentType: "Explore",
			}),
		).toBe(false);
	});

	it("does not block with no token budget", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "test",
			prompt: "test",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				subagentType: "Explore",
				description: "test",
				prompt: "test",
			}),
		).toBe(false);
	});

	it("creates block from token_budget abort completion", () => {
		const block = createBudgetRetryBlockFromCompletion(
			{
				budget: 100,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "inspect repository",
			},
			{ status: "aborted", abortReason: "token_budget" },
		);

		expect(block).toBeDefined();
		expect(block!.budget).toBe(100);
		expect(block!.subagentType).toBe("Explore");
	});

	it("does not create block for non-budget completions", () => {
		expect(
			createBudgetRetryBlockFromCompletion(
				{ budget: 100, subagentType: "Explore", description: "test", prompt: "test" },
				{ status: "completed" },
			),
		).toBeUndefined();
		expect(
			createBudgetRetryBlockFromCompletion(
				{ budget: 100, subagentType: "Explore", description: "test", prompt: "test" },
				{ status: "aborted", abortReason: "max_turns" },
			),
		).toBeUndefined();
	});

	it("blocks when only description matches (ignoring prompt)", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "completely different prompt",
			}),
		).toBe(true);
	});

	it("normalizes whitespace and case", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "  Explore  Agent  Extension  ",
			prompt: "inspect  repository",
		});

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "explore",
				description: "explore agent extension",
				prompt: "inspect repository",
			}),
		).toBe(true);
	});
});
