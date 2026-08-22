import { describe, it, expect } from "bun:test";

describe("batch-nudge", () => {
	it("sequential_tool_rounds_trigger_after_three_single_calls", () => {
		const { updateSequentialToolRounds, SEQUENTIAL_TOOL_ROUNDS_BEFORE_BATCH_NUDGE } = require("../../src/utils/batch-nudge");
		let rounds = 0;
		for (let i = 0; i < 3; i++) {
			rounds = updateSequentialToolRounds(rounds, 1, false);
		}
		expect(rounds).toBe(SEQUENTIAL_TOOL_ROUNDS_BEFORE_BATCH_NUDGE);
	});

	it("parallel_calls_reset_sequential_tool_rounds", () => {
		const { updateSequentialToolRounds } = require("../../src/utils/batch-nudge");
		expect(updateSequentialToolRounds(2, 2, false)).toBe(0);
	});

	it("batch_calls_reset_sequential_tool_rounds", () => {
		const { updateSequentialToolRounds } = require("../../src/utils/batch-nudge");
		expect(updateSequentialToolRounds(2, 1, true)).toBe(0);
	});

	it("pending_nudge_is_injected_only_when_batch_is_available", () => {
		const { shouldInjectBatchNudge } = require("../../src/utils/batch-nudge");
		expect(shouldInjectBatchNudge(true, true)).toBe(true);
		expect(shouldInjectBatchNudge(false, true)).toBe(false);
		expect(shouldInjectBatchNudge(true, false)).toBe(false);
	});

	it("batch_nudge_message_contains_batch_tool_reference", () => {
		const { BATCH_NUDGE_MESSAGE } = require("../../src/utils/batch-nudge");
		expect(BATCH_NUDGE_MESSAGE).toContain("use the batch tool");
		expect(BATCH_NUDGE_MESSAGE).toContain("result is required");
	});

	it("batch_tool_available_detects_batch_tool", () => {
		const { batchToolAvailable } = require("../../src/utils/batch-nudge");
		expect(batchToolAvailable([{ name: "read" }, { name: "batch" }])).toBe(true);
		expect(batchToolAvailable([{ name: "read" }, { name: "write" }])).toBe(false);
	});
});
