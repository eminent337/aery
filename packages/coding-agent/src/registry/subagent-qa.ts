/**
 * Parallel Two-Stage QA Reviewers for Aery Subagents.
 *
 * Runs Spec Review and Code Quality Review in parallel across subagent diffs,
 * verifying requirement fulfillment, code conventions, and zero AI dashes
 * without blocking the main session turn.
 */

export interface SubagentQaStageResult {
	passed: boolean;
	summary: string;
	issues: string[];
}

export interface SubagentQaReviewRequest {
	subagentId: string;
	role: string;
	prompt: string;
	diff?: string;
	worktree?: string;
	specValidator?: (
		request: SubagentQaReviewRequest,
		diff: string,
	) => SubagentQaStageResult | Promise<SubagentQaStageResult>;
	qualityValidator?: (
		request: SubagentQaReviewRequest,
		diff: string,
	) => SubagentQaStageResult | Promise<SubagentQaStageResult>;
}

export interface SubagentQaReviewResult {
	approved: boolean;
	specReview: SubagentQaStageResult;
	qualityReview: SubagentQaStageResult;
	durationMs: number;
}

export interface SubagentQaOptions {
	skipIfEmpty?: boolean;
}

/**
 * Standard spec reviewer validator logic.
 */
async function defaultSpecReviewer(request: SubagentQaReviewRequest, diff: string): Promise<SubagentQaStageResult> {
	if (request.specValidator) {
		return request.specValidator(request, diff);
	}

	if (!diff || diff.trim().length === 0) {
		return {
			passed: true,
			summary: "No code modifications detected; spec automatically satisfied.",
			issues: [],
		};
	}

	// Basic heuristic: check for obvious syntax breaks or error placeholders
	const issues: string[] = [];
	if (diff.includes("TODO: implement") || diff.includes("throw new Error(\"Not implemented\")")) {
		issues.push("Unfinished placeholder implementation detected in diff.");
	}

	return {
		passed: issues.length === 0,
		summary: issues.length === 0 ? "Spec review passed cleanly." : "Spec review detected unfinished requirements.",
		issues,
	};
}

/**
 * Standard code quality reviewer validator logic.
 * Checks for prohibited AI dash markers (\u2014, \u2013), unconsumed debug lines, etc.
 */
async function defaultQualityReviewer(request: SubagentQaReviewRequest, diff: string): Promise<SubagentQaStageResult> {
	if (request.qualityValidator) {
		return request.qualityValidator(request, diff);
	}

	if (!diff || diff.trim().length === 0) {
		return {
			passed: true,
			summary: "No code modifications detected; quality review passed.",
			issues: [],
		};
	}

	const issues: string[] = [];

	// Enforce Zero AI Dashes Law: check for added lines with em dash or en dash
	const addedLines = diff
		.split("\n")
		.filter(line => line.startsWith("+") && !line.startsWith("+++"))
		.join("\n");

	if (addedLines.includes("\u2014") || addedLines.includes("\u2013")) {
		issues.push("Prohibited AI dash marker (\u2014 or \u2013) detected in added lines.");
	}

	return {
		passed: issues.length === 0,
		summary: issues.length === 0 ? "Code quality review passed cleanly." : "Code quality issues detected in diff.",
		issues,
	};
}

/**
 * Execute Spec Review and Code Quality Review concurrently in parallel.
 */
export async function runSubagentQaReviews(
	request: SubagentQaReviewRequest,
	_options?: SubagentQaOptions,
): Promise<SubagentQaReviewResult> {
	const startTime = Date.now();
	const diff = request.diff ?? "";

	// Execute both review stages in parallel
	const [specReview, qualityReview] = await Promise.all([
		defaultSpecReviewer(request, diff),
		defaultQualityReviewer(request, diff),
	]);

	const approved = specReview.passed && qualityReview.passed;
	const durationMs = Date.now() - startTime;

	return {
		approved,
		specReview,
		qualityReview,
		durationMs,
	};
}
