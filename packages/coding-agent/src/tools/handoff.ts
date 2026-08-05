import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import handoffDescription from "../prompts/tools/handoff.md" with { type: "text" };
import type { HandoffToolResult, HandoffToolState, ToolSession } from ".";
import { ToolError } from "./tool-errors";

const handoffSchema = z.object({
	customInstructions: z
		.string()
		.describe("What the next session should know: context, decisions, open questions, and next steps."),
	autoTriggered: z
		.boolean()
		.optional()
		.describe("Whether this handoff is auto-triggered (internal maintenance flow). Leave unset for normal use."),
});

export type HandoffToolParams = z.infer<typeof handoffSchema>;

/**
 * Generate a handoff document from the live session and start a fresh session
 * with it as context.
 *
 * DESTRUCTIVE: this resets the agent and replaces the conversation with the
 * generated handoff document, so it is permission-gated (write tier, always
 * prompts outside yolo mode). Guards:
 * - Refuses while a handoff is already generating.
 * - Refuses when the session has fewer than 2 messages (nothing to hand off).
 * - Refuses consecutive handoffs: if the last visible message is already a
 *   handoff result and the session has almost no new content, don't loop.
 */
export class HandoffTool implements AgentTool<typeof handoffSchema, HandoffToolResult> {
	readonly name = "handoff";
	readonly label = "Handoff";
	readonly description = handoffDescription;
	readonly parameters = handoffSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Generate a handoff document and start a fresh session with it (destructive)";
	readonly intent = () => "handing off";
	readonly approval = (): ToolApprovalDecision => ({
		tier: "write",
		override: true,
		reason: "Destructive: starts a new session and resets the agent.",
	});

	constructor(private readonly session: ToolSession) {}

	async execute(
		_id: string,
		params: HandoffToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<HandoffToolResult>> {
		return untilAborted(signal, async () => {
			const state = this.session.getHandoffState?.();
			if (!state || !this.session.handoff) {
				throw new ToolError("handoff is not available in this session.");
			}
			this.#assertCanHandoff(state);

			let result: HandoffToolResult | undefined;
			try {
				result = await this.session.handoff(params.customInstructions, {
					autoTriggered: params.autoTriggered,
					signal,
				});
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
			if (!result) {
				return {
					content: [{ type: "text", text: "Handoff cancelled or failed; the session was not reset." }],
					details: { document: "" },
				};
			}
			const lines = [
				"Handoff complete. A new session has started with the generated handoff document as context.",
				`Document: ${result.savedPath ?? "(in-memory)"}`,
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: result,
			};
		});
	}

	#assertCanHandoff(state: HandoffToolState): void {
		if (state.isGenerating) {
			throw new ToolError("A handoff is already in progress.");
		}
		if (state.messageCount < 2) {
			throw new ToolError("Nothing to hand off: the session has fewer than 2 messages.");
		}
		if (state.lastHandoffText && state.messageCount <= 2) {
			throw new ToolError(
				"A handoff was just completed and there is no new work to hand off. Do not call handoff again until meaningful progress has been made.",
			);
		}
	}
}
