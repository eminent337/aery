/**
 * Multi-prompt code reviewer tool — runs multiple parallel review passes with
 * different focus perspectives and combines them into a single review.
 *
 * Ported from Freebuff's `reviewer/multi-prompt/code-reviewer-multi-prompt.ts`:
 * the orchestrator spawns one code-reviewer per prompt focus; here each focus
 * becomes a parallel `generateComplete` call, and the outputs are merged into
 * a structured findings report.
 */

import type { Api, AssistantMessage, Context, GenerateOptionsUnified, Model } from "@aryee337/aery-ai";
import { generateComplete } from "@aryee337/aery-ai";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import type { TreeNode } from "@aryee337/aery-tui";
import { ThoughtTree } from "@aryee337/aery-tui";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { extractAssistantText, resolveGenerationModel } from "./best-of-n";
import { ToolError } from "./tool-errors";

const multiPromptReviewSchema = z.object({
	subject: z
		.string()
		.describe(
			"The code, diff, or file changes to review. Include the full diff or code so reviewers can analyze it without conversation history.",
		),
	context: z
		.string()
		.optional()
		.describe(
			"Optional original request or requirements the change is expected to satisfy. Reviewers advocate for the user.",
		),
	prompts: z
		.array(z.string())
		.optional()
		.describe(
			"Optional custom review focus prompts (one review pass per prompt). Defaults to 3 perspectives: correctness & regression, edge cases & error handling, security & best practices.",
		),
	model: z.string().optional().describe("Optional model selector (e.g. 'aery/auto'). Defaults to the current model."),
});

export interface MultiPromptFinding {
	title: string;
	priority: "P0" | "P1" | "P2" | "P3";
	body: string;
	focus: string;
}

export interface MultiPromptReviewDetails {
	treeNodes?: TreeNode[];
	focuses: string[];
	reviews: { focus: string; text: string }[];
	findings: MultiPromptFinding[];
	model: string;
}

export type ReviewGenerateFn = (
	model: Model<Api>,
	context: Context,
	options?: GenerateOptionsUnified,
) => Promise<AssistantMessage>;

export const DEFAULT_REVIEW_FOCUSES: readonly string[] = [
	"Correctness and regression: verify all requirements in the original request are addressed, no logic was accidentally removed or broken, imports are present, and the change is minimal.",
	"Edge cases and error handling: check boundary conditions, failure paths, and unnecessary try/catch blocks. Prefer removing defensive code that hides real errors.",
	"Security and best practices: look for security vulnerabilities, dead code, style mismatches with the surrounding code, and opportunities to reuse existing helpers instead of duplicating logic.",
] as const;

/** Parse structured findings of the form `FINDING <P0..P3>: <title>` from a review. */
export function parseReviewFindings(text: string, focus: string): MultiPromptFinding[] {
	const findings: MultiPromptFinding[] = [];
	const lines = text.split("\n");
	let current: MultiPromptFinding | undefined;
	const flush = (): void => {
		if (current && (current.title || current.body)) {
			findings.push(current);
		}
		current = undefined;
	};
	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const header = /^FINDING\s+(P[0-3]):\s+(.+)$/.exec(line);
		if (header) {
			flush();
			current = {
				title: header[2].trim(),
				priority: header[1] as MultiPromptFinding["priority"],
				body: "",
				focus,
			};
			continue;
		}
		const bullet = /^[-*]\s+.*$/.test(line);
		if (!current && (line.length === 0 || bullet)) continue;
		if (current) {
			current.body = current.body ? `${current.body}\n${line.trim()}` : line.trim();
		}
	}
	flush();
	return findings;
}

/** Build the review prompt for one focus perspective. */
export function buildReviewPrompt(subject: string, focus: string, context: string | undefined): string {
	const requirementBlock = context ? `\n\nOriginal request the change must satisfy:\n${context}` : "";
	return `Review the following code change and provide critical feedback focused on: ${focus}

${subject}${requirementBlock}

Rules:
- Be brief. If the change looks good, say so in one sentence.
- Do not include strengths or praise — only actionable critical feedback.
- Advocate for the user: call out any requirement that is not addressed.
- Each finding must start on its own line with: FINDING P<0-3>: <imperative title>
  followed by one or two lines of concise explanation. P0 = blocker, P1 = should fix, P2 = should consider, P3 = nit.
- If there are no findings, output exactly: FINDING P3: No issues found.`;
}

export class MultiPromptReviewTool implements AgentTool<typeof multiPromptReviewSchema, MultiPromptReviewDetails> {
	readonly loadMode = "discoverable" as const;
	readonly name = "multi_prompt_review";
	readonly approval = "read" as const;
	readonly label = "Multi-Prompt Code Reviewer";
	readonly summary = "Runs multiple parallel review passes focused on different concerns and combines them.";
	readonly description =
		"Runs 3 (or custom) parallel code review passes over the provided code/diff, each focused on a different concern (correctness, edge cases, security). Combines all feedback into a single structured findings report. Use after significant edits to catch regressions before declaring work complete.";
	readonly parameters = multiPromptReviewSchema;

	#generate: ReviewGenerateFn;

	constructor(generateOverride?: ReviewGenerateFn) {
		this.#generate = generateOverride ?? generateComplete;
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof multiPromptReviewSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MultiPromptReviewDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<MultiPromptReviewDetails>> {
		const subject = params.subject.trim();
		if (!subject) throw new ToolError("multi_prompt_review: subject is required and must not be empty.");

		const focuses = params.prompts && params.prompts.length > 0 ? params.prompts : [...DEFAULT_REVIEW_FOCUSES];
		const treeNodes: TreeNode[] = focuses.map((p, i) => ({
			id: `prompt-${i}`,
			label: `Reviewing: ${p.substring(0, 30)}...`,
			state: "running",
		}));

		const pushUpdate = (details: Partial<MultiPromptReviewDetails> = {}) => {
			if (_onUpdate) {
				_onUpdate({
					content: [],
					details: { focuses, reviews: [], findings: [], model: "unknown", treeNodes, ...details },
				});
			}
		};
		pushUpdate();
		const model = await resolveGenerationModel(params.model, context);
		const modelSelector = `${model.provider}/${model.id}`;
		const apiKey = context?.modelRegistry ? await context.modelRegistry.getApiKey(model) : undefined;

		const results = await Promise.all(
			focuses.map(async focus => {
				const focusContext: Context = {
					systemPrompt: [
						"You are a code reviewer agent. Provide concise, actionable critical feedback on the given change. Do not edit any files.",
					],
					messages: [
						{
							role: "user",
							content: buildReviewPrompt(subject, focus, params.context),
							timestamp: Date.now(),
						},
					],
				};
				try {
					const message = await this.#generate(model, focusContext, { apiKey });
					return { focus, text: extractAssistantText(message) } satisfies { focus: string; text: string };
				} catch {
					return { focus, text: "" };
				}
			}),
		);

		const reviews = results.filter(review => review.text.length > 0);
		const findings = reviews.flatMap(review => {
			const parsed = parseReviewFindings(review.text, review.focus);
			return parsed.length > 0
				? parsed
				: [
						{
							title: "Review pass produced no structured findings",
							priority: "P3" as const,
							body: review.text,
							focus: review.focus,
						},
					];
		});

		const details: MultiPromptReviewDetails = {
			focuses,
			reviews,
			findings,
			model: modelSelector,
		};

		const report = renderReviewReport(details);
		return {
			content: [{ type: "text", text: report }],
			details,
		};
	}
	renderResult(
		result: AgentToolResult<MultiPromptReviewDetails>,
		options: RenderResultOptions,
		_theme: Theme,
	): unknown {
		if (result.details?.treeNodes) {
			return new ThoughtTree(result.details.treeNodes, options.spinnerFrame);
		}
		return undefined;
	}
}

/** Render the combined review report as text for the agent. */
export function renderReviewReport(details: MultiPromptReviewDetails): string {
	if (details.reviews.length === 0) {
		return "multi_prompt_review: all review passes failed. No findings produced.";
	}
	if (details.findings.length === 0) {
		return "multi_prompt_review: no findings across any review pass.";
	}
	const lines: string[] = [`Multi-prompt review (${details.reviews.length} passes, ${details.model}):`];
	for (const finding of details.findings) {
		lines.push(`\n[${finding.priority}] ${finding.title}`);
		if (finding.body) lines.push(finding.body);
		lines.push(`(focus: ${finding.focus})`);
	}
	return lines.join("\n");
}

/** Re-export resolveGenerationModel for custom callers that build review contexts. */
export { resolveGenerationModel } from "./best-of-n";
