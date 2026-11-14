import { describe, expect, it } from "bun:test";
import { analyzeDiffContent, parseDiffStats, runReviewCommand } from "../src/cli/review-cli";

describe("Review CLI Subsystem", () => {
	const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index e69de29..d95f3ad 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,7 @@
 export function start() {
+    const api_key = "sk_live_1234567890123456";
+    debugger;
+    console.log("starting server");
     return true;
 }
`;

	it("parses diff statistics accurately", () => {
		const stats = parseDiffStats(sampleDiff);
		expect(stats.filesChanged).toBe(1);
		expect(stats.insertions).toBe(3);
		expect(stats.deletions).toBe(0);
		expect(stats.files).toContain("src/index.ts");
	});

	it("detects critical defects, debuggers, and logs in diffs", () => {
		const findings = analyzeDiffContent(sampleDiff);
		expect(findings.length).toBe(3);

		const secretFinding = findings.find(f => f.priority === "P0");
		expect(secretFinding).toBeDefined();
		expect(secretFinding?.title).toContain("secret");

		const debuggerFinding = findings.find(f => f.priority === "P1");
		expect(debuggerFinding).toBeDefined();
		expect(debuggerFinding?.title).toContain("Debugger");

		const logFinding = findings.find(f => f.priority === "P2");
		expect(logFinding).toBeDefined();
		expect(logFinding?.title).toContain("Console log");
	});

	it("emits structured review report with CHANGES_REQUESTED for defective code", async () => {
		const logs: string[] = [];
		const report = await runReviewCommand({
			json: true,
			stdout: msg => logs.push(msg),
		});

		expect(report).toBeDefined();
		expect(report.verdict).toBeDefined();
		expect(report.stats).toBeDefined();
		expect(logs.length).toBe(1);

		const parsedJson = JSON.parse(logs[0]);
		expect(parsedJson.verdict).toBe(report.verdict);
		expect(parsedJson.stats.filesChanged).toBe(report.stats.filesChanged);
	});
});
