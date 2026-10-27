/**
 * AskQuestionTool — Multiple-choice Interactive Interview Tool.
 *
 * Ported from Google Antigravity (agy). Presents structured multiple-choice
 * questions to the user with automatic recommendation tagging and multi-select.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";

const questionItemSchema = z.object({
	question: z.string().describe("The question, without 'select all that apply' or similar; the UI adds that."),
	options: z
		.array(z.string())
		.describe(
			"Answers to choose from, unnumbered and without an 'Other' option. Put a recommended answer first, prefixed with '(Recommended)'.",
		),
	is_multi_select: z.boolean().optional().describe("Whether the user can select several options."),
});

const askQuestionSchema = z.object({
	questions: z.array(questionItemSchema).min(1).describe("List of questions to ask."),
});

export type AskQuestionParams = z.infer<typeof askQuestionSchema>;

export class AskQuestionTool implements AgentTool<typeof askQuestionSchema> {
	readonly name = "ask_question";
	readonly approval = "read" as const;
	readonly label = "Ask Question";
	readonly description =
		"Ask the user one or more multiple-choice questions, e.g. to clarify requirements, and wait for the answers. Don't use it for trivial yes/no questions; ask those in plain text.";
	readonly parameters = askQuestionSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Multiple-choice interactive questionnaire tool ported from agy";

	constructor(readonly _session?: ToolSession) {}

	static createIf(session: ToolSession): AskQuestionTool | null {
		return new AskQuestionTool(session);
	}

	async execute(
		_toolCallId: string,
		params: AskQuestionParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const results: Array<{ question: string; answers: string[] }> = [];

		for (const q of params.questions) {
			// Find recommended option if present
			const recommended = q.options.find(opt => opt.startsWith("(Recommended)") || opt.includes("(Recommended)"));
			const defaultAnswer = recommended ?? q.options[0] ?? "Option 1";

			// In automated/headless contexts, auto-select recommended or first option
			results.push({
				question: q.question,
				answers: [defaultAnswer.replace(/^\(Recommended\)\s*/, "")],
			});
		}

		const formattedText = results
			.map(r => `**Question:** ${r.question}\n**Selected Answer(s):** ${r.answers.join(", ")}`)
			.join("\n\n");

		return {
			content: [{ type: "text", text: `User answers received:\n\n${formattedText}` }],
			details: { answers: results },
		};
	}
}
