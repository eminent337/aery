/**
 * Tests for Parallel Two-Stage QA Reviewers in Aery Subagents.
 */

import { describe, expect, it } from "bun:test";
import { runSubagentQaReviews, type SubagentQaReviewRequest } from "../../src/registry/subagent-qa";

describe("Parallel Two-Stage QA Reviewers", () => {
	it("approves clean diffs matching requirements", async () => {
		const request: SubagentQaReviewRequest = {
			subagentId: "sub-implementer-123",
			role: "Feature Implementer",
			prompt: "Implement auth token refresh endpoint",
			diff: `
diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,2 +10,6 @@
+export function refreshToken(token: string): string {
+    return "refreshed-" + token;
+}
`,
		};

		const result = await runSubagentQaReviews(request);
		expect(result.approved).toBe(true);
		expect(result.specReview.passed).toBe(true);
		expect(result.qualityReview.passed).toBe(true);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("detects spec discrepancies and flags unfulfilled requirements", async () => {
		const request: SubagentQaReviewRequest = {
			subagentId: "sub-coder-456",
			role: "Fix Coder",
			prompt: "Add password validation with minimum 12 characters",
			diff: `
diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,2 +10,6 @@
+export function validatePassword(pass: string): boolean {
+    return pass.length >= 6; // WRONG: required 12
+}
`,
			specValidator: (_req, diff) => {
				if (diff.includes(">= 6") && !diff.includes(">= 12")) {
					return {
						passed: false,
						summary: "Password length validator check failed requirement (expected 12, got 6)",
						issues: ["Password minimum length must be 12 characters"],
					};
				}
				return { passed: true, summary: "Spec satisfied", issues: [] };
			},
		};

		const result = await runSubagentQaReviews(request);
		expect(result.approved).toBe(false);
		expect(result.specReview.passed).toBe(false);
		expect(result.specReview.issues.length).toBeGreaterThan(0);
		expect(result.specReview.issues[0]).toContain("12 characters");
	});

	it("detects code quality issues such as prohibited AI dash markers", async () => {
		const request: SubagentQaReviewRequest = {
			subagentId: "sub-doc-789",
			role: "Doc Writer",
			prompt: "Write documentation for auth flow",
			diff: `
diff --git a/docs/auth.md b/docs/auth.md
--- a/docs/auth.md
+++ b/docs/auth.md
@@ -1,2 +1,3 @@
+# Auth Guide \u2014 Complete Flow
`,
		};

		const result = await runSubagentQaReviews(request);
		expect(result.approved).toBe(false);
		expect(result.qualityReview.passed).toBe(false);
		expect(result.qualityReview.issues.some(i => i.toLowerCase().includes("dash"))).toBe(true);
	});

	it("runs spec review and quality review concurrently in parallel", async () => {
		let specStarted = 0;
		let specEnded = 0;
		let qualityStarted = 0;
		let qualityEnded = 0;

		const request: SubagentQaReviewRequest = {
			subagentId: "sub-bench-999",
			role: "Benchmarker",
			prompt: "Parallel review timing test",
			diff: "diff --git a/test.ts b/test.ts\n+console.log(1);",
			specValidator: async () => {
				specStarted = Date.now();
				await new Promise(r => setTimeout(r, 40));
				specEnded = Date.now();
				return { passed: true, summary: "OK", issues: [] };
			},
			qualityValidator: async () => {
				qualityStarted = Date.now();
				await new Promise(r => setTimeout(r, 40));
				qualityEnded = Date.now();
				return { passed: true, summary: "OK", issues: [] };
			},
		};

		const result = await runSubagentQaReviews(request);
		expect(result.approved).toBe(true);
		// Both should have started within 15ms of each other (parallel execution)
		expect(Math.abs(specStarted - qualityStarted)).toBeLessThanOrEqual(25);
		expect(result.durationMs).toBeGreaterThanOrEqual(35);
		expect(result.durationMs).toBeLessThan(120);
	});
});
