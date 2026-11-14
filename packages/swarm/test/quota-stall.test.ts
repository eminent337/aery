import { describe, expect, it } from "bun:test";
import { QuotaHandler } from "../src/supervisor/quota-handler";
import { StallMonitor } from "../src/supervisor/stall-monitor";
import type { SwarmMember } from "../src/types";

describe("QuotaHandler & StallMonitor", () => {
	it("detects 429 quota errors and formats advisory", () => {
		const handler = new QuotaHandler();
		const err429 = new Error("Rate limit exceeded: 429 Too Many Requests");

		expect(handler.isQuotaError(err429)).toBe(true);

		const advisory = handler.generateAdvisory("worker-1", "claude-3-7-sonnet");
		expect(advisory).toContain("@coordinator [QUOTA_PAUSED]");
		expect(advisory).toContain("worker-1");
		expect(advisory).toContain("claude-3-7-sonnet");
	});

	it("detects deadlocked swarm when all non-coordinator members are waiting", () => {
		const monitor = new StallMonitor();
		const members: SwarmMember[] = [
			{
				name: "coordinator",
				brief: "Lead",
				state: "working",
				workspace: "inherit",
				lastSeqRead: 1,
				createdAt: new Date().toISOString(),
			},
			{
				name: "worker-1",
				brief: "Subtask",
				state: "waiting",
				workspace: "inherit",
				lastSeqRead: 1,
				createdAt: new Date().toISOString(),
			},
		];

		const stall = monitor.checkStall(members, 1, 1);
		expect(stall.stalled).toBe(true);
		expect(stall.alertMessage).toContain("@coordinator [stall]");
	});
});
