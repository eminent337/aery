import { describe, expect, it } from "bun:test";
import { executeExternalAgent } from "../src/extensibility/external-agents/runner";

describe("External Agent Runner", () => {
	it("executes a command synchronously and captures stdout", async () => {
		const result = await executeExternalAgent({
			agentId: "custom",
			prompt: "hello from test",
			options: {
				customBinary: "echo",
				background: false,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello from test");
		expect(result.timedOut).toBe(false);
	});

	it("handles non-zero exit codes gracefully without crashing", async () => {
		const result = await executeExternalAgent({
			agentId: "custom",
			prompt: "",
			options: {
				customBinary: "bash",
				extraArgs: ["-c", "exit 42"],
				background: false,
			},
		});

		expect(result.exitCode).toBe(42);
	});

	it("respects timeouts", async () => {
		const result = await executeExternalAgent({
			agentId: "custom",
			prompt: "ignored",
			options: {
				customBinary: "bash",
				extraArgs: ["-c", "sleep 5"],
				timeoutMs: 200,
				background: false,
			},
		});

		expect(result.timedOut).toBe(true);
		expect(result.error).toContain("timed out");
	});
});
