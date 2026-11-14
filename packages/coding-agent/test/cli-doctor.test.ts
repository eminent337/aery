import { describe, expect, it } from "bun:test";
import { runDiagnostics } from "../src/cli/doctor-cli";

describe("Doctor Diagnostics CLI", () => {
	it("collects diagnostics report across all primary categories", async () => {
		const report = await runDiagnostics();

		expect(report).toBeDefined();
		expect(report.version).toBeDefined();
		expect(report.platform).toBeDefined();
		expect(report.checks.length).toBeGreaterThan(5);

		const categories = new Set(report.checks.map(c => c.category));
		expect(categories.has("Environment")).toBe(true);
		expect(categories.has("Configuration")).toBe(true);
		expect(categories.has("Connectivity")).toBe(true);

		const runtimeCheck = report.checks.find(c => c.name === "runtime");
		expect(runtimeCheck).toBeDefined();
		expect(runtimeCheck?.status).toBe("ok");

		const gitCheck = report.checks.find(c => c.name === "git");
		expect(gitCheck).toBeDefined();

		expect(report.summary.ok).toBeGreaterThan(0);
	});
});
