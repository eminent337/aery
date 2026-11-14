import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateMarkdownReport, runUltraReview } from "../src/cli/ultrareview-cli";

describe("UltraReview Multi-Agent Analyzer", () => {
	it("should run ultrareview on current git repo and generate valid summary", async () => {
		const result = await runUltraReview();

		expect(result).toBeDefined();
		expect(result.target).toBeDefined();
		expect(result.summary).toBeDefined();
		expect(typeof result.summary.critical).toBe("number");
		expect(typeof result.summary.high).toBe("number");
		expect(typeof result.summary.medium).toBe("number");
		expect(Array.isArray(result.findings)).toBe(true);
	});

	it("should format markdown report with findings table", () => {
		const mockResult = {
			target: "HEAD",
			baseCommit: "a1b2c3d4e5",
			filesChanged: 2,
			additions: 15,
			deletions: 5,
			findings: [
				{
					id: "SEC-1",
					category: "security" as const,
					severity: "critical" as const,
					file: "src/auth.ts",
					line: 42,
					title: "Hardcoded credential",
					description: "String literal with secret",
					recommendation: "Use environment variable",
				},
			],
			timestamp: new Date().toISOString(),
			summary: {
				critical: 1,
				high: 0,
				medium: 0,
				low: 0,
				nit: 0,
			},
		};

		const md = generateMarkdownReport(mockResult);
		expect(md).toContain("# Autonomous UltraReview Report");
		expect(md).toContain("SEC-1");
		expect(md).toContain("src/auth.ts:42");
		expect(md).toContain("Hardcoded credential");
	});
});
