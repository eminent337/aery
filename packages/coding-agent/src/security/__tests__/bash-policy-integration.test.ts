import { describe, expect, it } from "bun:test";
import { executeBash } from "../../exec/bash-executor";

describe("PolicyGuardian Bash Integration", () => {
	it("intercepts and blocks a git commit adding .env before execution", async () => {
		const result = await executeBash("git add .env && git commit -m 'secret'");
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("[PolicyGuardian] Action denied");
		expect(result.output).toContain(".env files is prohibited");
	});

	it("intercepts and blocks rm -rf / before execution", async () => {
		const result = await executeBash("rm -rf /");
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("[PolicyGuardian] Action denied");
		expect(result.output).toContain("system or home root");
	});

	it("allows harmless bash commands through", async () => {
		const result = await executeBash("echo 'policy check passed'");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("policy check passed");
	});

	it("honors skipPolicyGuardian when explicitly set", async () => {
		// When skipPolicyGuardian is true, the pre-check does not intercept
		// (even though git itself may fail or succeed)
		const result = await executeBash("git status", { skipPolicyGuardian: true });
		expect(result.output).not.toContain("[PolicyGuardian]");
	});
});
