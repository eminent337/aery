/**
 * Autonomous Runtime Tests
 */

import { describe, expect, it } from "bun:test";
import { AutonomousRuntime } from "../src/autonomous/runtime.js";
import type { AutonomousRuntimeHost } from "../src/autonomous/types.js";

describe("AutonomousRuntime", () => {
	const createMockHost = (): AutonomousRuntimeHost => {
		let state: any = null;
		const events: any[] = [];

		return {
			getCurrentUsage: () => ({ input: 100, output: 200 }),
			now: () => Date.now(),
			executeCommand: async (command: string) => {
				if (command.includes("fail")) {
					return { exitCode: 1, stdout: "", stderr: "failed" };
				}
				return { exitCode: 0, stdout: "ok", stderr: "" };
			},
			emit: (event: any) => events.push(event),
			getState: () => state,
			setState: (s: any) => {
				state = s;
			},
			persist: async (s: any) => {
				state = s;
			},
			sendHiddenMessage: async () => {},
		} as unknown as AutonomousRuntimeHost;
	};

	it("should start with idle state", () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);
		expect(runtime.status).toBe("idle");
		expect(runtime.isEnabled).toBe(false);
	});

	it("should start autonomous execution", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		const state = await runtime.start({
			objective: "Test objective",
			config: { budget: { tokens: 1000 } },
		});

		expect(state.status).toBe("active");
		expect(state.objective).toBe("Test objective");
		expect(runtime.isEnabled).toBe(true);
		expect(runtime.tokensUsed).toBe(0);
	});

	it("should track token usage on turn completion", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({ objective: "Test" });

		// Mock usage to simulate token consumption
		host.getCurrentUsage = () => ({ input: 500, output: 500 });

		const result = await runtime.onTurnComplete();

		expect(result.shouldContinue).toBe(true);
		expect(runtime.tokensUsed).toBe(1000);
	});

	it("should stop when budget exhausted", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({
			objective: "Test",
			config: { budget: { tokens: 500 } },
		});

		// Simulate exceeding budget
		host.getCurrentUsage = () => ({ input: 300, output: 300 });

		const result = await runtime.onTurnComplete();

		expect(result.shouldContinue).toBe(false);
		expect(runtime.status).toBe("budget-exhausted");
	});

	it("should run quality gates", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({
			objective: "Test",
			config: {
				gates: [
					{ name: "test", command: "echo ok" },
					{ name: "lint", command: "biome check" },
				],
			},
		});

		const result = await runtime.onTurnComplete();

		expect(result.shouldContinue).toBe(true);
	});

	it("should fail on gate failure", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({
			objective: "Test",
			config: {
				gates: [{ name: "failing", command: "echo fail && exit 1" }],
			},
		});

		const result = await runtime.onTurnComplete();

		expect(result.shouldContinue).toBe(false);
		expect(runtime.status).toBe("gate-failed");
	});

	it("should pause and resume", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({ objective: "Test" });
		expect(runtime.isEnabled).toBe(true);

		await runtime.pause();
		expect(runtime.isEnabled).toBe(false);
		expect(runtime.status).toBe("paused");

		await runtime.resume();
		expect(runtime.isEnabled).toBe(true);
		expect(runtime.status).toBe("active");
	});

	it("should abort execution", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({ objective: "Test" });
		await runtime.abort("manual stop");

		expect(runtime.status).toBe("aborted");
		expect(runtime.isEnabled).toBe(false);
	});

	it("should complete execution", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);

		await runtime.start({ objective: "Test" });
		const result = await runtime.complete();

		expect(result.success).toBe(true);
		expect(runtime.status).toBe("complete");
	});

	it("should throw when no active session", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);
		await expect(runtime.pause()).rejects.toThrow("No active autonomous session");
		await expect(runtime.resume()).rejects.toThrow("No active autonomous session");
	});

	it("should validate objective is not empty", async () => {
		const host = createMockHost();
		const runtime = new AutonomousRuntime(host);
		await expect(runtime.start({ objective: "   " })).rejects.toThrow("Objective is required");
	});
});
