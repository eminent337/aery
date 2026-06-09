/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@aryee337/aery-ai";
import type { AgentMessage } from "../types";
import { estimateTokens } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadToolResult],
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number): number {
	const noticeTokens = Math.ceil(createPrunedNotice(tokens).length / 4);
	return Math.max(0, tokens - noticeTokens);
}

export interface MessagePruneConfig {
	/** Max tokens for user messages (backward walk). 0 = disabled. */
	userBudget: number;
	/** Max tokens for assistant messages (backward walk). 0 = disabled. */
	assistantBudget: number;
	/** Chars per token estimate. Default: 4. */
	charsPerToken: number;
}

/**
 * Prune old user/assistant messages when separate budgets are exceeded.
 * Walks backward from newest, keeping most recent messages within budget.
 * Tool results and other message types are not affected.
 *
 * Ported from Freebuff's context-pruner backward-walk algorithm.
 */
export function pruneMessages(entries: SessionEntry[], config: MessagePruneConfig): PruneResult {
	if (config.userBudget <= 0 && config.assistantBudget <= 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const cpt = config.charsPerToken || 4;
	let userTokens = 0;
	let assistantTokens = 0;
	let prunedCount = 0;
	let tokensSaved = 0;
	let cutoffIndex = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as any;
		if (!msg.content) continue;
		const text =
			typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content
							.filter((p: any) => p.type === "text")
							.map((p: any) => p.text ?? "")
							.join("")
					: "";
		const tokens = Math.ceil(text.length / cpt);

		if (msg.role === "user") {
			if (config.userBudget > 0 && userTokens + tokens > config.userBudget) {
				cutoffIndex = i + 1;
				break;
			}
			userTokens += tokens;
		} else if (msg.role === "assistant") {
			if (config.assistantBudget > 0 && assistantTokens + tokens > config.assistantBudget) {
				cutoffIndex = i + 1;
				break;
			}
			assistantTokens += tokens;
		}
	}

	for (let i = cutoffIndex - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as any;
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		if (!msg.content) continue;
		const text =
			typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content
							.filter((p: any) => p.type === "text")
							.map((p: any) => p.text ?? "")
							.join("")
					: "";
		const tokens = Math.ceil(text.length / cpt);
		if (tokens <= 0) continue;

		msg.content = `[Pruned — ~${tokens} tokens]`;
		tokensSaved += tokens;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number }> = [];
	const toolCallsById = collectToolCallsById(entries);

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		const isProtected = isProtectedToolResult(message, toolCallsById.get(message.toolCallId), config.protectedTools);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		if (accumulatedTokens < config.protectTokens || isProtected) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(candidate.tokens);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: createPrunedNotice(candidate.tokens) }];
		message.prunedAt = prunedAt;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}
