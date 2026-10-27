import { describe, expect, it } from "bun:test";
import { AmbientScheduler } from "../../ambient/scheduler";
import { ScheduleTool } from "../schedule";

describe("ScheduleTool agy compatibility", () => {
	const mockBus: any = { emit: () => {} };
	const scheduler = new AmbientScheduler("test-session", mockBus);
	const tool = new ScheduleTool(scheduler);

	it("schedules using DurationSeconds and Prompt (agy format)", async () => {
		const result = await tool.execute("call-1", {
			DurationSeconds: 15,
			Prompt: "Follow up with user regarding migration progress",
		});

		expect((result.content[0] as any).text).toContain("Scheduled task");
		expect((result.details as any)?.dueAt).toBeGreaterThan(Date.now() + 10_000);
		expect((result.details as any)?.dueAt).toBeLessThanOrEqual(Date.now() + 16_000);
	});

	it("supports CronExpression and TimerCondition metadata", async () => {
		const result = await tool.execute("call-2", {
			CronExpression: "*/5 * * * *",
			Prompt: "Run periodic health check",
			TimerCondition: "any",
		});

		expect((result.content[0] as any).text).toContain("[Cron: */5 * * * *]");
		expect((result.details as any)?.cronExpression).toBe("*/5 * * * *");
		expect((result.details as any)?.timerCondition).toBe("any");
	});

	it("preserves legacy message and dueAt parameters", async () => {
		const specificDue = Date.now() + 50_000;
		const result = await tool.execute("call-3", {
			message: "Legacy reminder",
			dueAt: specificDue,
			priority: "high",
		});

		expect(result.details.dueAt).toBe(specificDue);
		expect(result.details.priority).toBe("high");
	});
});
